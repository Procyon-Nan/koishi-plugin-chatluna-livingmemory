import { readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from 'koishi'
import type {
    DreamNeighborQuery,
    DreamVectorProvider,
    MemoryHybridSearchHit,
    MemoryHybridSearchInput,
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink,
    MemoryVectorIndexState,
    MemoryVectorIndexStatus,
    MemoryVectorSearch
} from '../../contracts/vector_index'
import { formatErrorDetails, toError } from '../shared/utils'
import { LivingMemoryVectorIndexError } from './errors'
import { VectorIndexDirectorySwitch } from './directory_switch'
import type { VectorIndexDirectoryActivation } from './directory_switch'
import {
    LivingMemoryVectorIndexMaintenance,
    type LivingMemoryVectorIndexRepository
} from './maintenance'
import {
    createVectorIndexVector,
    type VectorIndexEmbeddingContext
} from './embedding'
import { buildVectorIndexWorkerMutation } from './mutation_builder'
import {
    VectorIndexOperationGate,
    VectorIndexPresetMutationQueue
} from './operation_gate'
import { VectorIndexStatusStore } from './status_store'
import { VECTOR_INDEX_SCHEMA_VERSION } from './worker/schema'
import { LivingMemoryVectorIndexWorkerClient } from './worker_client'
import type { VectorIndexInspection } from './worker_protocol'
import type { LivingMemoryLogger } from '../logging/logger'
import {
    acquireVectorIndexGeneration,
    type LivingMemoryVectorIndexGeneration
} from './generation_coordinator'

export type VectorIndexWorkerFactory = (
    onFailure: (error: Error) => void,
    onWarning: (error: Error) => void
) => LivingMemoryVectorIndexWorkerClient

interface VectorIndexServiceOptions {
    schemaVersion?: number
    workerFactory?: VectorIndexWorkerFactory
}

const createDefaultWorker: VectorIndexWorkerFactory = (onFailure, onWarning) =>
    new LivingMemoryVectorIndexWorkerClient(undefined, onFailure, onWarning)

const legacyIndexFiles = new Set([
    'vector-index.sqlite',
    'vector-index.previous.sqlite'
])
const legacyRebuildFile = /^vector-index\.rebuild-.+\.sqlite$/u

export class LivingMemoryVectorIndexService
    implements DreamVectorProvider, MemoryIndexMutationSink, MemoryVectorSearch
{
    private readonly operationGate = new VectorIndexOperationGate()
    private readonly presetMutationQueue = new VectorIndexPresetMutationQueue(
        this.operationGate
    )

    private readonly status = new VectorIndexStatusStore()

    private readonly indexDirectory: string
    private readonly databaseDirectory: string
    private readonly previousDatabaseDirectory: string
    private readonly maintenance: LivingMemoryVectorIndexMaintenance
    private readonly directorySwitch: VectorIndexDirectorySwitch
    private readonly workerFactory: VectorIndexWorkerFactory
    private worker: LivingMemoryVectorIndexWorkerClient | null = null
    private initialization: Promise<void> | null = null
    private maintenanceTail: Promise<void> = Promise.resolve()
    private workerFailure: Error | null = null
    private embeddingContext: VectorIndexEmbeddingContext | null = null
    private generation: LivingMemoryVectorIndexGeneration | null = null
    private stopPromise: Promise<void> | null = null

    constructor(
        ctx: Context,
        private readonly config: { embeddingModel: string; debug: boolean },
        private readonly repository: LivingMemoryVectorIndexRepository,
        private readonly logger: LivingMemoryLogger,
        options: VectorIndexServiceOptions = {}
    ) {
        const schemaVersion =
            options.schemaVersion ?? VECTOR_INDEX_SCHEMA_VERSION
        this.workerFactory = options.workerFactory ?? createDefaultWorker
        this.directorySwitch = new VectorIndexDirectorySwitch({
            reportWarning: (warning) =>
                this.logger.summary(
                    '索引目录维护提示',
                    `原因：${warning}`,
                    'warn'
                )
        })

        this.indexDirectory = resolve(
            ctx.baseDir,
            'data',
            'chatluna',
            'living-memory'
        )
        this.databaseDirectory = resolve(
            this.indexDirectory,
            'vector-index.pglite'
        )
        this.previousDatabaseDirectory = resolve(
            this.indexDirectory,
            'vector-index.previous.pglite'
        )
        this.maintenance = new LivingMemoryVectorIndexMaintenance({
            ctx,
            config,
            repository,
            operationGate: this.operationGate,
            schemaVersion,
            indexDirectory: this.indexDirectory,
            previousDatabaseDirectory: this.previousDatabaseDirectory,
            finalizeRebuild: (input, transferCleanupOwnership) =>
                this.finalizeRebuild(input, transferCleanupOwnership),
            worker: () => this.requireWorker(),
            shouldStop: () => this.operationGate.stopping,
            onBuilding: (jobId) => this.markBuilding(jobId),
            onCurrentJobChanged: (jobId) => this.status.setCurrentJob(jobId),
            onInspection: (inspection) =>
                this.status.applyInspection(inspection),
            onEmbeddingContext: (context) => {
                this.embeddingContext = context
            },
            logger: this.logger
        })
    }

    async start() {
        const generationKey =
            process.platform === 'win32'
                ? this.databaseDirectory.toLowerCase()
                : this.databaseDirectory
        try {
            this.generation = await acquireVectorIndexGeneration(generationKey)
        } catch (error) {
            const failure = toError(error)
            this.status.markUnavailable(failure.message)
            this.logger.summary(
                '向量索引启动失败',
                '状态：暂停检索',
                'error',
                failure
            )
            throw error
        }

        try {
            this.operationGate.assertAccepting()
            this.worker = this.workerFactory(
                (error) => this.recordWorkerFailure(error),
                (warning) =>
                    this.logger.summary(
                        '索引工作线程警告',
                        '操作：维护向量索引',
                        'warn',
                        warning
                    )
            )
            const inspection = await this.worker.open(
                this.databaseDirectory,
                this.previousDatabaseDirectory
            )
            this.operationGate.assertAccepting()
            this.status.applyInspection(inspection)
            this.status.markStarting()
            this.initialization = this.queueMaintenance(async () => {
                try {
                    await this.initialize(inspection)
                } catch (error) {
                    await this.handleMaintenanceFailure(error)
                } finally {
                    this.status.endMaintenance()
                }
            })
        } catch (error) {
            const failure = toError(error)
            this.status.markUnavailable(failure.message)
            this.logger.summary(
                '向量索引启动失败',
                '状态：暂停检索',
                'error',
                failure
            )
            try {
                await this.disposeCurrentWorker()
            } finally {
                this.releaseGeneration()
            }
            throw error
        }
    }

    async stop() {
        this.beginStop()
        this.stopPromise ??= this.stopService()
        return this.stopPromise
    }

    beginStop() {
        this.operationGate.beginStop()
        this.generation?.beginStop()
    }

    private async stopService() {
        await this.operationGate.drain()
        await this.waitForMaintenanceDuringStop()
        try {
            await this.disposeCurrentWorker()
        } finally {
            this.releaseGeneration()
        }
    }

    async restart() {
        await this.stop()
        this.workerFailure = null
        this.embeddingContext = null
        this.initialization = null
        this.maintenanceTail = Promise.resolve()
        this.stopPromise = null
        this.operationGate.reset()
        this.status.reset()
        await this.start()
    }

    getStatus(): MemoryVectorIndexStatus {
        return this.status.snapshot()
    }

    async waitForInitialization() {
        if (this.initialization !== null) {
            await this.initialization
        }
    }

    async readVectorSnapshot(
        presetId: string,
        memoryIds: string[],
        signal?: AbortSignal
    ) {
        return this.operationGate.run(async () => {
            await this.awaitPresetReadBarrier(presetId)
            signal?.throwIfAborted()
            return this.requireWorker().readVectorSnapshot(presetId, memoryIds)
        })
    }

    async queryDreamNeighbors(
        queries: DreamNeighborQuery[],
        signal?: AbortSignal
    ) {
        return this.operationGate.run(async () => {
            for (const presetId of new Set(
                queries.map((query) => query.presetId)
            )) {
                await this.awaitPresetReadBarrier(presetId)
            }
            return this.requireWorker().queryDreamNeighbors(queries, signal)
        })
    }

    async searchHybrid(
        input: MemoryHybridSearchInput
    ): Promise<MemoryHybridSearchHit[]> {
        return this.operationGate.run(async () => {
            this.assertPresetReady(input.presetId)
            const vectors = await this.embedSearchTexts(input.searchTexts)
            await this.awaitPresetReadBarrier(input.presetId)

            const bestHits = new Map<string, MemoryHybridSearchHit>()
            for (const vector of vectors) {
                const hits = await this.requireWorker().queryHybrid({
                    presetId: input.presetId,
                    conversationId: input.conversationId,
                    excludedMemoryIds: input.excludedMemoryIds,
                    types: input.memoryTypes,
                    memoryStatus: input.memoryStatus,
                    limit: input.maxCandidates,
                    vector,
                    keywords: input.keywords,
                    minSimilarity: input.minSimilarity
                })
                for (const hit of hits) {
                    const current = bestHits.get(hit.memoryId)
                    if (
                        current === undefined ||
                        hit.boostedScore > current.boostedScore ||
                        (hit.boostedScore === current.boostedScore &&
                            hit.cosineScore > current.cosineScore)
                    ) {
                        bestHits.set(hit.memoryId, hit)
                    }
                }
            }

            return [...bestHits.values()]
                .sort((left, right) => {
                    const scoreDifference =
                        right.boostedScore - left.boostedScore
                    if (scoreDifference !== 0) {
                        return scoreDifference
                    }
                    return left.memoryId.localeCompare(right.memoryId)
                })
                .slice(0, input.maxCandidates)
        })
    }

    private runPresetMutation<T>(presetId: string, task: () => Promise<T>) {
        return this.presetMutationQueue.run(presetId, task)
    }

    async waitForMaintenance() {
        await this.maintenanceTail
    }

    async applyMutation(batch: MemoryIndexMutationBatch): Promise<void> {
        await this.operationGate.run(async () => {
            await this.waitForMaintenance()
            await this.runPresetMutation(batch.presetId, async () => {
                this.assertPresetReady(batch.presetId)
                let indexedCount = this.status.getPresetIndexedCount(
                    batch.presetId
                )
                try {
                    const mutation = await buildVectorIndexWorkerMutation(
                        batch,
                        this.requireEmbeddingContext()
                    )
                    const result =
                        await this.requireWorker().applyMutation(mutation)
                    indexedCount = result.indexedCount
                    const expectedCount =
                        await this.repository.countEntriesByPreset(
                            batch.presetId
                        )
                    if (result.indexedCount !== expectedCount) {
                        throw new Error(
                            `vector index mutation count mismatch: ` +
                                `preset=${batch.presetId}, expected=${expectedCount}, ` +
                                `actual=${result.indexedCount}`
                        )
                    }
                    await this.requireWorker().markPresetState({
                        presetId: batch.presetId,
                        state: 'ready',
                        expectedCount,
                        indexedCount: result.indexedCount,
                        lastError: null,
                        updatedAt: Date.now()
                    })
                    await this.refreshInspection()
                } catch (error) {
                    throw await this.markMutationFailed(
                        batch.presetId,
                        indexedCount,
                        error
                    )
                }
            })
        })
    }

    async clearPreset(presetId: string): Promise<void> {
        await this.operationGate.run(async () => {
            await this.waitForMaintenance()
            await this.runPresetMutation(presetId, async () => {
                let indexedCount = this.status.getPresetIndexedCount(presetId)
                try {
                    await this.requireWorker().clearPreset(presetId)
                    indexedCount = 0
                    await this.refreshInspection()
                } catch (error) {
                    throw await this.markMutationFailed(
                        presetId,
                        indexedCount,
                        error
                    )
                }
            })
        })
    }

    async reconcilePreset(presetId: string, reason: string) {
        return this.operationGate.run(async () => {
            const expectedCount =
                await this.repository.countEntriesByPreset(presetId)
            const job = await this.maintenance.createPresetReconcileJob(
                presetId,
                reason
            )
            this.markPresetBuilding(presetId, job.id, expectedCount)
            void this.queueMaintenance(async () => {
                try {
                    await this.maintenance.runPresetReconcileJob(job, reason)
                    this.clearUnavailableIfHealthy()
                } catch (error) {
                    await this.handleMaintenanceFailure(error)
                } finally {
                    this.status.clearPresetBuilding(presetId)
                }
            })
            return job
        })
    }

    private rebuild(reason: string) {
        return this.queueMaintenance(async () => {
            try {
                await this.maintenance.rebuild(reason)
                this.clearUnavailableIfHealthy()
            } catch (error) {
                await this.handleMaintenanceFailure(error)
            } finally {
                this.status.endMaintenance()
            }
        })
    }

    private clearUnavailableIfHealthy() {
        if (this.workerFailure === null) {
            this.status.clearUnavailable()
        }
    }

    startRebuild(reason: string) {
        this.operationGate.assertAccepting()
        this.status.setCurrentJob(null)
        this.status.markStarting()
        void this.rebuild(reason)
    }

    private async initialize(inspection: VectorIndexInspection) {
        if (this.workerFailure !== null) {
            throw new LivingMemoryVectorIndexError(
                'worker-unavailable',
                'unavailable',
                `vector index worker unavailable: ${this.workerFailure.message}`,
                { cause: this.workerFailure }
            )
        }
        await this.maintenance.initialize(inspection)
        try {
            await this.removeLegacyIndexFiles()
        } catch (error) {
            this.logger.summary(
                '旧索引文件清理失败',
                '操作：清理旧索引文件',
                'warn',
                error
            )
        }
    }

    private async removeLegacyIndexFiles() {
        const filenames = await readdir(this.indexDirectory)
        for (const filename of filenames) {
            if (
                !legacyIndexFiles.has(filename) &&
                !legacyRebuildFile.test(filename)
            ) {
                continue
            }
            await unlink(resolve(this.indexDirectory, filename))
        }
    }

    private async embedSearchTexts(searchTexts: string[]) {
        const context = this.requireEmbeddingContext()
        const generated = await Promise.all(
            searchTexts.map((searchText) =>
                context.embeddings.embedQuery(searchText)
            )
        )
        return generated.map((vector, index) =>
            createVectorIndexVector(
                vector,
                context.dimension,
                `searchTextIndex=${index}`
            )
        )
    }

    assertPresetReady(presetId: string) {
        this.status.assertPresetReady(presetId)
    }

    private requireEmbeddingContext() {
        if (this.embeddingContext === null) {
            throw new LivingMemoryVectorIndexError(
                'embedding-unavailable',
                'unavailable',
                'vector index embedding context is not initialized'
            )
        }
        return this.embeddingContext
    }

    private async markMutationFailed(
        presetId: string,
        indexedCount: number,
        error: unknown
    ) {
        const failure = toError(error)
        const expectedCount =
            await this.repository.countEntriesByPreset(presetId)
        if (this.worker !== null && this.workerFailure === null) {
            await this.worker.markPresetState({
                presetId,
                state: 'dirty',
                expectedCount,
                indexedCount,
                lastError: failure.message,
                updatedAt: Date.now()
            })
            await this.refreshInspection()
        } else {
            this.status.markUnavailable(failure.message)
        }
        return new LivingMemoryVectorIndexError(
            'mutation-failed',
            'dirty',
            `vector index mutation failed: preset=${presetId}: ${failure.message}`,
            { cause: error }
        )
    }

    private async refreshInspection() {
        const inspection = await this.requireWorker().inspect()
        this.status.applyInspection(inspection)
    }

    private async finalizeRebuild(
        input: {
            rebuildDatabaseDirectory: string
            expectedCount: number
            manifest: NonNullable<VectorIndexInspection['manifest']>
        },
        transferCleanupOwnership: () => void
    ) {
        const currentWorker = this.requireWorker()
        await currentWorker.validateAndCloseRebuildDatabase(input.expectedCount)
        transferCleanupOwnership()

        let activation: VectorIndexDirectoryActivation | null = null
        try {
            activation = await this.directorySwitch.activate(
                this.databaseDirectory,
                input.rebuildDatabaseDirectory,
                this.previousDatabaseDirectory
            )
            const inspection = await currentWorker.openCandidate(
                this.databaseDirectory
            )
            this.assertFinalizedInspection(inspection, input)
            await this.directorySwitch.cleanup(
                this.previousDatabaseDirectory,
                'previous index cleanup after rebuild'
            )
            return inspection
        } catch (error) {
            await currentWorker.closeDatabase()
            if (activation !== null) {
                try {
                    await this.directorySwitch.rollback(activation)
                } catch (rollbackError) {
                    await this.recoverAfterRollbackFailure(
                        currentWorker,
                        input,
                        error,
                        rollbackError
                    )
                }
            }
            try {
                await this.restoreActiveDatabase(
                    currentWorker,
                    input,
                    'failed rebuild cleanup after rollback'
                )
            } catch (recoveryError) {
                throw new Error(
                    `vector index rebuild switch failed: ` +
                        `${formatErrorDetails(error)}; recovery failed: ` +
                        formatErrorDetails(recoveryError),
                    { cause: error }
                )
            }
            throw error
        }
    }

    private async recoverAfterRollbackFailure(
        worker: LivingMemoryVectorIndexWorkerClient,
        input: {
            rebuildDatabaseDirectory: string
            manifest: NonNullable<VectorIndexInspection['manifest']>
        },
        switchError: unknown,
        rollbackError: unknown
    ) {
        const message =
            `vector index rebuild switch failed: ` +
            `${formatErrorDetails(switchError)}; rollback failed: ` +
            formatErrorDetails(rollbackError)
        try {
            await this.restoreActiveDatabase(
                worker,
                input,
                'failed rebuild cleanup after rollback failure'
            )
        } catch (recoveryError) {
            throw new Error(
                `${message}; recovery failed: ${formatErrorDetails(recoveryError)}`,
                {
                    cause: switchError
                }
            )
        }
        throw new Error(message, { cause: switchError })
    }

    /**
     * 切换失败后在同一 worker 中重开 active 目录；若恢复出的 generation 与
     * 重建 manifest 不一致，说明 active 仍是旧库，清理孤立的 rebuild 目录。
     */
    private async restoreActiveDatabase(
        worker: LivingMemoryVectorIndexWorkerClient,
        input: {
            rebuildDatabaseDirectory: string
            manifest: NonNullable<VectorIndexInspection['manifest']>
        },
        cleanupOperation: string
    ) {
        const inspection = await worker.openCandidate(this.databaseDirectory)
        if (inspection.manifest?.generation !== input.manifest.generation) {
            await this.directorySwitch.cleanup(
                input.rebuildDatabaseDirectory,
                cleanupOperation
            )
        }
    }

    private assertFinalizedInspection(
        inspection: VectorIndexInspection,
        expected: {
            expectedCount: number
            manifest: NonNullable<VectorIndexInspection['manifest']>
        }
    ) {
        if (
            inspection.indexedCount !== expected.expectedCount ||
            inspection.manifest?.generation !== expected.manifest.generation
        ) {
            throw new Error(
                `vector index finalized inspection mismatch: ` +
                    `expectedCount=${expected.expectedCount}, ` +
                    `actualCount=${inspection.indexedCount}, ` +
                    `expectedGeneration=${expected.manifest.generation}, ` +
                    `actualGeneration=${inspection.manifest?.generation ?? 'none'}`
            )
        }
    }

    private async disposeWorker(worker: LivingMemoryVectorIndexWorkerClient) {
        try {
            await worker.dispose()
        } catch (error) {
            this.logger.summary(
                '索引工作线程关闭失败',
                '操作：释放索引资源',
                'warn',
                error
            )
        }
    }

    private markBuilding(jobId: string) {
        this.status.markBuilding(jobId)
    }

    private markPresetBuilding(
        presetId: string,
        jobId: string,
        expectedCount: number
    ) {
        this.status.markPresetBuilding(presetId, jobId, expectedCount)
    }

    private async awaitPresetReadBarrier(presetId: string) {
        await this.presetMutationQueue.wait(presetId)
        this.assertPresetReady(presetId)
    }

    private async handleMaintenanceFailure(error: unknown) {
        const failure = toError(error)
        let state: MemoryVectorIndexState = 'unavailable'
        if (
            this.workerFailure === null &&
            error instanceof LivingMemoryVectorIndexError
        ) {
            state = error.state
        }
        await this.inspectAfterFailure()
        if (state === 'unavailable') {
            this.status.markUnavailable(failure.message)
        } else {
            this.status.markRuntimeError(failure.message)
        }
        if (this.workerFailure === null) {
            if (state === 'unavailable') {
                this.logger.summary(
                    '向量索引服务异常',
                    `状态：暂停检索; 原因：${failure.message}`,
                    'error'
                )
            } else {
                const stateLabel = {
                    building: '构建中',
                    ready: '就绪',
                    dirty: '待同步'
                }[state]
                this.logger.summary(
                    '向量索引维护异常',
                    `状态：${stateLabel}; 原因：${failure.message}`,
                    'warn'
                )
            }
        }
    }

    private async inspectAfterFailure() {
        if (this.workerFailure !== null || this.worker === null) {
            return
        }
        try {
            const inspection = await this.worker.inspect()
            this.status.applyInspection(inspection)
        } catch (error) {
            this.logger.diagnosticSummary(() => ({
                event: '索引故障后状态读取失败',
                detail: `原因：${formatErrorDetails(error)}`
            }))
        }
    }

    private recordWorkerFailure(error: Error) {
        this.workerFailure = error
        this.status.markUnavailable(error.message)
        this.logger.summary(
            '索引工作线程故障',
            '状态：暂停检索',
            'error',
            error
        )
    }

    private async waitForMaintenanceDuringStop() {
        if (this.initialization !== null) {
            await this.initialization
        }
        await this.maintenanceTail
    }

    private requireWorker() {
        if (this.workerFailure !== null) {
            throw new LivingMemoryVectorIndexError(
                'worker-unavailable',
                'unavailable',
                `vector index worker unavailable: ${this.workerFailure.message}`,
                { cause: this.workerFailure }
            )
        }
        if (this.worker === null) {
            throw new LivingMemoryVectorIndexError(
                'worker-unavailable',
                'unavailable',
                'vector index worker is not running'
            )
        }
        return this.worker
    }

    private queueMaintenance(task: () => Promise<void>) {
        const operation = this.maintenanceTail.then(task)
        this.maintenanceTail = operation.then(
            () => undefined,
            () => undefined
        )
        return operation
    }

    private async disposeCurrentWorker() {
        if (this.worker === null) {
            return
        }
        const worker = this.worker
        this.worker = null
        await this.disposeWorker(worker)
    }

    private releaseGeneration() {
        this.generation?.release()
        this.generation = null
    }
}
