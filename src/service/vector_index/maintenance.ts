import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from 'koishi'
import type { MemoryJobRecord } from '../../contracts/memory'
import type { MemoryVectorIndexManifest } from '../../contracts/vector_index'
import { isModelConfigured } from '../shared/utils'
import {
    type EmbeddingsLike,
    probeVectorIndexDimension,
    type VectorIndexEmbeddingContext
} from './embedding'
import { LivingMemoryVectorIndexError } from './errors'
import {
    LivingMemoryVectorIndexJobRunner,
    type VectorIndexJobRepository
} from './job_runner'
import type { VectorIndexOperationGate } from './operation_gate'
import {
    reconcileVectorIndexPreset,
    type VectorIndexReconcileProgress,
    type VectorIndexReconcileRepository
} from './reconcile'
import {
    rebuildVectorIndex,
    type VectorIndexRebuildRepository
} from './rebuild'
import type { LivingMemoryVectorIndexWorkerClient } from './worker_client'
import type { VectorIndexInspection } from './worker_protocol'
import type { LivingMemoryLogger } from '../logging/logger'

const VECTOR_STORAGE_ENGINE = 'pglite-pgvector' as const
const GLOBAL_INDEX_JOB_PRESET = '*'

export interface LivingMemoryVectorIndexRepository
    extends
        VectorIndexRebuildRepository,
        VectorIndexReconcileRepository,
        VectorIndexJobRepository {
    countEntries(): Promise<number>
    hasMigratedLegacyEmbeddings(): Promise<boolean>
    completeLegacyEmbeddingMigration(): Promise<void>
}

interface VectorIndexMaintenanceOptions {
    ctx: Context
    config: { embeddingModel: string; debug: boolean }
    repository: LivingMemoryVectorIndexRepository
    worker: () => LivingMemoryVectorIndexWorkerClient
    operationGate: VectorIndexOperationGate
    schemaVersion: number
    indexDirectory: string
    previousDatabaseDirectory: string
    finalizeRebuild: (
        input: {
            rebuildDatabaseDirectory: string
            expectedCount: number
            manifest: MemoryVectorIndexManifest
        },
        transferCleanupOwnership: () => void
    ) => Promise<VectorIndexInspection>
    shouldStop: () => boolean
    onBuilding: (jobId: string) => void
    onCurrentJobChanged: (jobId: string | null) => void
    onInspection: (inspection: VectorIndexInspection) => void
    onEmbeddingContext: (context: VectorIndexEmbeddingContext) => void
    logger: LivingMemoryLogger
}

export class LivingMemoryVectorIndexMaintenance {
    private readonly jobRunner: LivingMemoryVectorIndexJobRunner

    constructor(private readonly options: VectorIndexMaintenanceOptions) {
        this.jobRunner = new LivingMemoryVectorIndexJobRunner(
            options.repository,
            options.onCurrentJobChanged,
            options.logger
        )
    }

    async initialize(
        inspection: VectorIndexInspection | null,
        openError: Error | null
    ) {
        const reuseLegacyEmbeddings =
            !(await this.options.repository.hasMigratedLegacyEmbeddings())
        const { embeddings, dimension } = await this.createEmbeddingContext()
        const rebuildReason = this.resolveRebuildReason(
            inspection,
            dimension,
            openError
        )
        if (rebuildReason !== null) {
            await this.runRebuildJob(
                embeddings,
                dimension,
                rebuildReason,
                reuseLegacyEmbeddings
            )
        } else {
            await this.runReconcileJob(embeddings, dimension)
        }
        await this.options.repository.completeLegacyEmbeddingMigration()
    }

    async rebuild(reason: string) {
        const { embeddings, dimension } = await this.createEmbeddingContext()
        await this.runRebuildJob(embeddings, dimension, reason, false)
        await this.options.repository.completeLegacyEmbeddingMigration()
    }

    createPresetReconcileJob(presetId: string, reason: string) {
        return this.jobRunner.create(presetId, `reconcile: ${reason}`)
    }

    async runPresetReconcileJob(job: MemoryJobRecord, reason: string) {
        const input = `reconcile: ${reason}`
        await this.jobRunner.runCreated(job, input, async () => {
            const { embeddings, dimension } =
                await this.createEmbeddingContext()
            const indexedCount = await this.options.operationGate.runExclusive(
                () =>
                    reconcileVectorIndexPreset({
                        presetId: job.presetId,
                        repository: this.options.repository,
                        worker: this.options.worker(),
                        embeddings,
                        embeddingModelId: this.options.config.embeddingModel,
                        dimension,
                        shouldStop: this.options.shouldStop,
                        onProgress: (progress) =>
                            this.reportReconcileProgress(job, progress)
                    })
            )
            const inspection = await this.options.worker().inspect()
            this.options.onInspection(inspection)
            return [
                'vector index reconcile completed:',
                `jobId=${job.id}`,
                `presetId=${job.presetId}`,
                `indexed=${indexedCount}`
            ].join(' ')
        })
    }

    private async createEmbeddings(): Promise<EmbeddingsLike> {
        const { ctx, config } = this.options
        if (!isModelConfigured(config.embeddingModel)) {
            throw new LivingMemoryVectorIndexError(
                'embedding-unavailable',
                'unavailable',
                'vector index embedding model is not configured'
            )
        }
        const result = await ctx.chatluna.createEmbeddings(
            config.embeddingModel
        )
        if (result.value === undefined) {
            throw new LivingMemoryVectorIndexError(
                'embedding-unavailable',
                'unavailable',
                `vector index embedding unavailable: model=${config.embeddingModel}`
            )
        }
        return result.value
    }

    private async createEmbeddingContext() {
        const embeddings = await this.createEmbeddings()
        const dimension = await probeVectorIndexDimension(embeddings)
        const context: VectorIndexEmbeddingContext = {
            embeddings,
            embeddingModelId: this.options.config.embeddingModel,
            dimension
        }
        this.options.onEmbeddingContext(context)
        return context
    }

    private resolveRebuildReason(
        inspection: VectorIndexInspection | null,
        dimension: number,
        openError: Error | null
    ) {
        const { config, schemaVersion } = this.options
        if (openError !== null) {
            return `database open failed: ${openError.message}`
        }
        if (inspection === null || inspection.manifest === null) {
            return 'index manifest is missing'
        }
        if (inspection.manifest.storageEngine !== VECTOR_STORAGE_ENGINE) {
            return (
                `vector index storage engine changed: expected=${VECTOR_STORAGE_ENGINE}, ` +
                `actual=${inspection.manifest.storageEngine}`
            )
        }
        if (
            inspection.vectorExtensionVersion !==
            inspection.manifest.vectorExtensionVersion
        ) {
            return (
                `manifest pgvector version changed: ` +
                `manifest=${inspection.manifest.vectorExtensionVersion}, ` +
                `runtime=${inspection.vectorExtensionVersion}`
            )
        }

        const manifest = inspection.manifest
        if (manifest.schemaVersion !== schemaVersion) {
            return (
                `schema version changed: expected=${schemaVersion}, ` +
                `actual=${manifest.schemaVersion}`
            )
        }
        if (manifest.embeddingModelId !== config.embeddingModel) {
            return (
                `embedding model changed: expected=${config.embeddingModel}, ` +
                `actual=${manifest.embeddingModelId}`
            )
        }
        if (manifest.dimension !== dimension) {
            return (
                `embedding dimension changed: expected=${dimension}, ` +
                `actual=${manifest.dimension}`
            )
        }
        if (manifest.storageEngine !== VECTOR_STORAGE_ENGINE) {
            return (
                `manifest storage engine changed: expected=${VECTOR_STORAGE_ENGINE}, ` +
                `actual=${manifest.storageEngine}`
            )
        }
        return null
    }

    private async runRebuildJob(
        embeddings: EmbeddingsLike,
        dimension: number,
        reason: string,
        reuseLegacyEmbeddings: boolean
    ) {
        const {
            config,
            repository,
            indexDirectory,
            schemaVersion,
            operationGate
        } = this.options
        await this.jobRunner.run(
            GLOBAL_INDEX_JOB_PRESET,
            `rebuild: ${reason}`,
            async (job) => {
                this.options.onBuilding(job.id)
                const manifest: MemoryVectorIndexManifest = {
                    schemaVersion,
                    embeddingModelId: config.embeddingModel,
                    dimension,
                    storageEngine: VECTOR_STORAGE_ENGINE,
                    vectorExtensionVersion: (
                        await this.options.worker().inspect()
                    ).vectorExtensionVersion,
                    generation: randomUUID(),
                    builtAt: Date.now()
                }
                const rebuildDatabaseDirectory = resolve(
                    indexDirectory,
                    `vector-index.rebuild-${job.id}.pglite`
                )
                const inspection = await rebuildVectorIndex({
                    repository,
                    worker: this.options.worker(),
                    embeddings,
                    embeddingModelId: config.embeddingModel,
                    dimension,
                    reuseLegacyEmbeddings,
                    manifest,
                    rebuildDatabaseDirectory,
                    shouldStop: this.options.shouldStop,
                    onProgress: async (progress) => {
                        const detail = [
                            'vector index rebuild progress:',
                            `jobId=${job.id}`,
                            `presetId=${job.presetId}`,
                            `completed=${progress.completed}`,
                            `total=${progress.total}`
                        ].join(' ')
                        await repository.updateJob(job.id, {
                            detail,
                            updatedAt: new Date()
                        })
                        this.options.logger.diagnostic(
                            'vector-index.rebuild.progress',
                            {
                                workflow: 'vector-index',
                                jobId: job.id,
                                presetId: job.presetId,
                                completed: progress.completed,
                                total: progress.total,
                                batchElapsedMs: Number(
                                    progress.batchDuration.toFixed(1)
                                ),
                                elapsedMs: Number(
                                    progress.totalDuration.toFixed(1)
                                )
                            }
                        )
                    },
                    finalize: (transferCleanupOwnership) =>
                        operationGate.runExclusive(async () => {
                            await this.reconcileAllPresets(
                                embeddings,
                                dimension,
                                job
                            )
                            const expectedCount =
                                await repository.countEntries()
                            return this.options.finalizeRebuild(
                                {
                                    rebuildDatabaseDirectory,
                                    expectedCount,
                                    manifest
                                },
                                transferCleanupOwnership
                            )
                        })
                })
                this.options.onInspection(inspection)
                return [
                    'vector index rebuild completed:',
                    `jobId=${job.id}`,
                    `presetId=${job.presetId}`,
                    `indexed=${inspection.indexedCount}`
                ].join(' ')
            }
        )
    }

    private async runReconcileJob(
        embeddings: EmbeddingsLike,
        dimension: number
    ) {
        await this.jobRunner.run(
            GLOBAL_INDEX_JOB_PRESET,
            'reconcile: startup',
            async (job) => {
                this.options.onBuilding(job.id)
                await this.options.operationGate.runExclusive(() =>
                    this.reconcileAllPresets(embeddings, dimension, job)
                )
                const inspection = await this.options.worker().inspect()
                this.options.onInspection(inspection)
                return [
                    'vector index reconcile completed:',
                    `jobId=${job.id}`,
                    `presetId=${job.presetId}`,
                    `indexed=${inspection.indexedCount}`
                ].join(' ')
            }
        )
    }

    private async reconcileAllPresets(
        embeddings: EmbeddingsLike,
        dimension: number,
        job: MemoryJobRecord
    ) {
        const { config, repository } = this.options
        const inspection = await this.options.worker().inspect()
        const sourcePresetIds = await repository.listEntryPresetIds()
        const presetIds = new Set(sourcePresetIds)
        for (const inventory of inspection.inventory) {
            presetIds.add(inventory.presetId)
        }

        for (const presetId of [...presetIds].sort()) {
            await reconcileVectorIndexPreset({
                presetId,
                repository,
                worker: this.options.worker(),
                embeddings,
                embeddingModelId: config.embeddingModel,
                dimension,
                shouldStop: this.options.shouldStop,
                onProgress: (progress) =>
                    this.reportReconcileProgress(job, progress)
            })
        }
    }

    private async reportReconcileProgress(
        job: MemoryJobRecord,
        progress: VectorIndexReconcileProgress
    ) {
        const detail = [
            'vector index reconcile progress:',
            `jobId=${job.id}`,
            `presetId=${progress.presetId}`,
            `completed=${progress.completed}`,
            `total=${progress.total}`
        ].join(' ')
        await this.options.repository.updateJob(job.id, {
            detail,
            updatedAt: new Date()
        })
        this.options.logger.diagnostic('vector-index.reconcile.progress', {
            workflow: 'vector-index',
            jobId: job.id,
            presetId: progress.presetId,
            completed: progress.completed,
            total: progress.total
        })
    }
}
