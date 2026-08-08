import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from 'koishi'
import type { MemoryJobRecord } from '../../contracts/memory'
import type { MemoryVectorIndexManifest } from '../../contracts/vector_index'
import type { EmbeddingsLike } from '../shared/embeddings'
import { isModelConfigured } from '../shared/utils'
import { probeVectorIndexDimension } from './embedding'
import { LivingMemoryVectorIndexError } from './errors'
import {
    LivingMemoryVectorIndexJobRunner,
    type VectorIndexJobRepository
} from './job_runner'
import type { VectorIndexOperationGate } from './operation_gate'
import {
    reconcileVectorIndexPreset,
    type VectorIndexReconcileRepository
} from './reconcile'
import {
    rebuildVectorIndex,
    type VectorIndexRebuildRepository
} from './rebuild'
import type { LivingMemoryVectorIndexWorkerClient } from './worker_client'
import type { VectorIndexInspection } from './worker_protocol'

const SQLITE_VEC_VERSION = 'v0.1.9'
const GLOBAL_INDEX_JOB_PRESET = '*'

export interface LivingMemoryVectorIndexRepository
    extends VectorIndexRebuildRepository,
        VectorIndexReconcileRepository,
        VectorIndexJobRepository {
    countEntries(): Promise<number>
}

interface VectorIndexMaintenanceOptions {
    ctx: Context
    config: { embeddingModel: string; debug: boolean }
    repository: LivingMemoryVectorIndexRepository
    worker: () => LivingMemoryVectorIndexWorkerClient
    operationGate: VectorIndexOperationGate
    schemaVersion: number
    indexDirectory: string
    previousDatabasePath: string
    shouldStop: () => boolean
    onBuilding: (jobId: string) => void
    onCurrentJobChanged: (jobId: string | null) => void
    onInspection: (inspection: VectorIndexInspection) => void
    debug: (message: string) => void
}

export class LivingMemoryVectorIndexMaintenance {
    private readonly jobRunner: LivingMemoryVectorIndexJobRunner

    constructor(private readonly options: VectorIndexMaintenanceOptions) {
        this.jobRunner = new LivingMemoryVectorIndexJobRunner(
            options.repository,
            options.onCurrentJobChanged
        )
    }

    async initialize(
        inspection: VectorIndexInspection | null,
        openError: Error | null
    ) {
        const embeddings = await this.createEmbeddings()
        const dimension = await probeVectorIndexDimension(embeddings)
        const rebuildReason = this.resolveRebuildReason(
            inspection,
            dimension,
            openError
        )
        if (rebuildReason !== null) {
            await this.runRebuildJob(
                embeddings,
                dimension,
                rebuildReason
            )
            return
        }
        await this.runReconcileJob(embeddings, dimension)
    }

    async rebuild(reason: string) {
        const embeddings = await this.createEmbeddings()
        const dimension = await probeVectorIndexDimension(embeddings)
        await this.runRebuildJob(embeddings, dimension, reason)
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
        if (inspection.sqliteVecVersion !== SQLITE_VEC_VERSION) {
            return (
                `sqlite-vec version changed: expected=${SQLITE_VEC_VERSION}, ` +
                `actual=${inspection.sqliteVecVersion}`
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
        if (manifest.sqliteVecVersion !== inspection.sqliteVecVersion) {
            return (
                `manifest sqlite-vec version changed: ` +
                `manifest=${manifest.sqliteVecVersion}, ` +
                `runtime=${inspection.sqliteVecVersion}`
            )
        }
        return null
    }

    private async runRebuildJob(
        embeddings: EmbeddingsLike,
        dimension: number,
        reason: string
    ) {
        const {
            config,
            repository,
            indexDirectory,
            schemaVersion,
            operationGate,
            previousDatabasePath
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
                    sqliteVecVersion: SQLITE_VEC_VERSION,
                    generation: randomUUID(),
                    builtAt: Date.now()
                }
                const rebuildDatabasePath = resolve(
                    indexDirectory,
                    `vector-index.rebuild-${job.id}.sqlite`
                )
                const inspection = await rebuildVectorIndex({
                    repository,
                    worker: this.options.worker(),
                    embeddings,
                    embeddingModelId: config.embeddingModel,
                    dimension,
                    manifest,
                    rebuildDatabasePath,
                    shouldStop: this.options.shouldStop,
                    onProgress: async (progress) => {
                        const detail =
                            `vector index rebuild: ` +
                            `${progress.completed}/${progress.total}`
                        await repository.updateJob(job.id, {
                            detail,
                            updatedAt: new Date()
                        })
                        this.options.debug(
                            `${detail}, batch=${progress.batchDuration.toFixed(1)}ms, ` +
                                `total=${progress.totalDuration.toFixed(1)}ms`
                        )
                    },
                    finalize: () =>
                        operationGate.runExclusive(async () => {
                            await this.reconcileAllPresets(
                                embeddings,
                                dimension,
                                job
                            )
                            const expectedCount =
                                await repository.countEntries()
                            return await this.options
                                .worker()
                                .finalizeRebuild(
                                    previousDatabasePath,
                                    expectedCount
                                )
                        })
                })
                this.options.onInspection(inspection)
                return `vector index rebuild completed: ${inspection.indexedCount} entries`
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
                await this.options.operationGate.runExclusive(async () => {
                    await this.reconcileAllPresets(
                        embeddings,
                        dimension,
                        job
                    )
                })
                const inspection = await this.options.worker().inspect()
                this.options.onInspection(inspection)
                return `vector index reconcile completed: ${inspection.indexedCount} entries`
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
                onProgress: async (progress) => {
                    const detail =
                        `vector index reconcile: preset=${presetId}, ` +
                        `${progress.completed}/${progress.total}`
                    await repository.updateJob(job.id, {
                        detail,
                        updatedAt: new Date()
                    })
                    this.options.debug(detail)
                }
            })
        }
    }
}
