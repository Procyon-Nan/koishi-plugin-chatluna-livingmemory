import { resolve } from 'node:path'
import type { Context, Logger } from 'koishi'
import type {
    IncrementalDreamNeighborInput,
    IncrementalDreamNeighborSearch,
    ManualDreamVectorReader,
    MemoryHybridSearchHit,
    MemoryHybridSearchInput,
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink,
    MemorySemanticSearchInput,
    MemoryVectorIndexState,
    MemoryVectorIndexStatus,
    MemoryVectorSearch,
    MemoryVectorSearchHit
} from '../../contracts/vector_index'
import { summarizeError, toError } from '../shared/utils'
import { LivingMemoryVectorIndexError } from './errors'
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
import { LivingMemoryVectorIndexOwnershipLock } from './ownership_lock'
import { VectorIndexStatusStore } from './status_store'
import { VECTOR_INDEX_SCHEMA_VERSION } from './worker/schema'
import { LivingMemoryVectorIndexWorkerClient } from './worker_client'
import type { VectorIndexInspection } from './worker_protocol'

export type VectorIndexWorkerFactory = (
    onFailure: (error: Error) => void
) => LivingMemoryVectorIndexWorkerClient

interface VectorIndexServiceOptions {
    schemaVersion?: number
    workerFactory?: VectorIndexWorkerFactory
}

const createDefaultWorker: VectorIndexWorkerFactory = (onFailure) =>
    new LivingMemoryVectorIndexWorkerClient(undefined, onFailure)

export class LivingMemoryVectorIndexService
    implements
        ManualDreamVectorReader,
        MemoryIndexMutationSink,
        MemoryVectorSearch,
        IncrementalDreamNeighborSearch
{
    private readonly operationGate = new VectorIndexOperationGate()
    private readonly presetMutationQueue = new VectorIndexPresetMutationQueue(
        this.operationGate
    )

    private readonly status = new VectorIndexStatusStore()

    private readonly databasePath: string
    private readonly previousDatabasePath: string
    private readonly ownershipLock: LivingMemoryVectorIndexOwnershipLock
    private readonly maintenance: LivingMemoryVectorIndexMaintenance
    private readonly workerFactory: VectorIndexWorkerFactory
    private worker: LivingMemoryVectorIndexWorkerClient | null = null
    private initialization: Promise<void> | null = null
    private maintenanceTail: Promise<void> = Promise.resolve()
    private workerFailure: Error | null = null
    private embeddingContext: VectorIndexEmbeddingContext | null = null
    private stopping = false

    constructor(
        ctx: Context,
        private readonly config: { embeddingModel: string; debug: boolean },
        private readonly repository: LivingMemoryVectorIndexRepository,
        private readonly logger: Logger,
        options: VectorIndexServiceOptions = {}
    ) {
        const schemaVersion =
            options.schemaVersion ?? VECTOR_INDEX_SCHEMA_VERSION
        this.workerFactory = options.workerFactory ?? createDefaultWorker

        const indexDirectory = resolve(
            ctx.baseDir,
            'data',
            'chatluna',
            'living-memory'
        )
        this.databasePath = resolve(indexDirectory, 'vector-index.sqlite')
        this.previousDatabasePath = resolve(
            indexDirectory,
            'vector-index.previous.sqlite'
        )
        this.ownershipLock = new LivingMemoryVectorIndexOwnershipLock(
            resolve(indexDirectory, 'vector-index.lock'),
            (error) => this.recordWorkerFailure(error)
        )
        this.maintenance = new LivingMemoryVectorIndexMaintenance({
            ctx,
            config,
            repository,
            operationGate: this.operationGate,
            schemaVersion,
            indexDirectory,
            previousDatabasePath: this.previousDatabasePath,
            worker: () => this.requireWorker(),
            shouldStop: () => this.stopping,
            onBuilding: (jobId) => this.markBuilding(jobId),
            onCurrentJobChanged: (jobId) => this.status.setCurrentJob(jobId),
            onInspection: (inspection) =>
                this.status.applyInspection(inspection),
            onEmbeddingContext: (context) => {
                this.embeddingContext = context
            },
            debug: (message) => this.debug(message)
        })
    }

    async start() {
        try {
            await this.ownershipLock.acquire()
        } catch (error) {
            const failure = toError(error)
            this.status.markFailure('unavailable', failure.message)
            this.logger.warn(failure)
            throw error
        }
        try {
            this.worker = this.workerFactory((error) => {
                this.recordWorkerFailure(error)
            })
        } catch (error) {
            await this.ownershipLock.release()
            throw error
        }

        let inspection: VectorIndexInspection | null = null
        let openError: Error | null = null
        try {
            inspection = await this.worker.open(
                this.databasePath,
                this.previousDatabasePath
            )
        } catch (error) {
            openError = toError(error)
        }

        this.status.markStarting(openError?.message ?? null)
        this.initialization = this.queueMaintenance(async () => {
            try {
                await this.initialize(inspection, openError)
            } catch (error) {
                await this.handleMaintenanceFailure(error)
            }
        })
    }

    async stop() {
        this.stopping = true
        await this.waitForMaintenanceDuringStop()
        if (this.worker !== null) {
            try {
                await this.worker.dispose()
            } catch (error) {
                this.logger.warn(
                    [
                        'memory background operation failed:',
                        'workflow=vector-index',
                        'operation=vector-index-worker-dispose'
                    ].join(' '),
                    error
                )
            }
            this.worker = null
        }
        await this.ownershipLock.release()
    }

    async restart() {
        await this.stop()
        this.stopping = false
        this.workerFailure = null
        this.embeddingContext = null
        this.initialization = null
        this.maintenanceTail = Promise.resolve()
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

    async readVectors(
        presetId: string,
        memoryIds: string[]
    ): Promise<Map<string, Float32Array<ArrayBuffer>>> {
        await this.awaitPresetReadBarrier(presetId)
        const items = await this.readRequiredVectors(presetId, memoryIds)
        const vectors = new Map<string, Float32Array<ArrayBuffer>>()
        for (const item of items) {
            vectors.set(item.memoryId, item.vector)
        }
        return vectors
    }

    async searchSemantic(
        input: MemorySemanticSearchInput
    ): Promise<MemoryVectorSearchHit[]> {
        this.assertPresetReady(input.presetId)
        const vectors = await this.embedSearchTexts(input.searchTexts)
        await this.awaitPresetReadBarrier(input.presetId)

        const bestScores = new Map<string, number>()
        for (const vector of vectors) {
            const hits = await this.requireWorker().queryKnn({
                presetId: input.presetId,
                status: input.status,
                types: input.memoryTypes,
                isConsolidated: null,
                limit: input.maxCandidates,
                vector
            })
            for (const hit of hits) {
                const current = bestScores.get(hit.memoryId)
                if (current === undefined || hit.cosineScore > current) {
                    bestScores.set(hit.memoryId, hit.cosineScore)
                }
            }
        }

        return [...bestScores]
            .map(([memoryId, cosineScore]) => ({ memoryId, cosineScore }))
            .sort((left, right) => {
                const scoreDifference = right.cosineScore - left.cosineScore
                if (scoreDifference !== 0) {
                    return scoreDifference
                }
                return left.memoryId.localeCompare(right.memoryId)
            })
            .slice(0, input.maxCandidates)
    }

    async searchHybrid(
        input: MemoryHybridSearchInput
    ): Promise<MemoryHybridSearchHit[]> {
        this.assertPresetReady(input.presetId)
        const vectors = await this.embedSearchTexts(input.searchTexts)
        await this.awaitPresetReadBarrier(input.presetId)

        const bestHits = new Map<string, MemoryHybridSearchHit>()
        for (const vector of vectors) {
            const hits = await this.requireWorker().queryHybrid({
                presetId: input.presetId,
                status: input.status,
                types: input.memoryTypes,
                isConsolidated: null,
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
                const scoreDifference = right.boostedScore - left.boostedScore
                if (scoreDifference !== 0) {
                    return scoreDifference
                }
                return left.memoryId.localeCompare(right.memoryId)
            })
            .slice(0, input.maxCandidates)
    }

    async findConsolidatedNeighbors(
        input: IncrementalDreamNeighborInput
    ): Promise<string[]> {
        return this.runPresetMutation(input.presetId, async () => {
            this.assertPresetReady(input.presetId)
            const [seed] = await this.readRequiredVectors(input.presetId, [
                input.seedMemoryId
            ])
            const excludedMemoryIds = new Set(input.excludedMemoryIds)
            excludedMemoryIds.add(input.seedMemoryId)
            const hits = await this.requireWorker().queryKnn({
                presetId: input.presetId,
                status: input.status,
                types: null,
                isConsolidated: true,
                limit: input.limit + excludedMemoryIds.size,
                vector: seed.vector
            })
            return hits
                .filter((hit) => !excludedMemoryIds.has(hit.memoryId))
                .slice(0, input.limit)
                .map((hit) => hit.memoryId)
        })
    }

    runPresetMutation<T>(presetId: string, task: () => Promise<T>) {
        return this.presetMutationQueue.run(presetId, task)
    }

    async waitForMaintenance() {
        await this.maintenanceTail
    }

    async applyMutation(batch: MemoryIndexMutationBatch): Promise<void> {
        await this.waitForMaintenance()
        await this.runPresetMutation(batch.presetId, async () => {
            this.assertPresetReady(batch.presetId)
            let indexedCount = this.status.getPresetIndexedCount(batch.presetId)
            try {
                const mutation = await buildVectorIndexWorkerMutation(
                    batch,
                    this.requireEmbeddingContext()
                )
                const result =
                    await this.requireWorker().applyMutation(mutation)
                indexedCount = result.indexedCount
                const expectedCount =
                    await this.repository.countEntriesByPreset(batch.presetId)
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
    }

    async clearPreset(presetId: string): Promise<void> {
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
    }

    async reconcilePreset(presetId: string, reason: string) {
        const expectedCount =
            await this.repository.countEntriesByPreset(presetId)
        const job = await this.maintenance.createPresetReconcileJob(
            presetId,
            reason
        )
        this.markPresetBuilding(presetId, job.id, expectedCount)
        this.queueMaintenance(async () => {
            try {
                this.markPresetBuilding(presetId, job.id, expectedCount)
                await this.maintenance.runPresetReconcileJob(job, reason)
            } catch (error) {
                await this.handleMaintenanceFailure(error)
            }
        })
        return job
    }

    private rebuild(reason: string) {
        return this.queueMaintenance(async () => {
            try {
                await this.maintenance.rebuild(reason)
            } catch (error) {
                await this.handleMaintenanceFailure(error)
            }
        })
    }

    startRebuild(reason: string) {
        this.status.setCurrentJob(null)
        this.status.markStarting(null)
        this.rebuild(reason)
    }

    private async initialize(
        inspection: VectorIndexInspection | null,
        openError: Error | null
    ) {
        if (this.workerFailure !== null) {
            throw new LivingMemoryVectorIndexError(
                'worker-unavailable',
                'unavailable',
                `vector index worker unavailable: ${this.workerFailure.message}`,
                { cause: this.workerFailure }
            )
        }
        await this.maintenance.initialize(inspection, openError)
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

    private async readRequiredVectors(presetId: string, memoryIds: string[]) {
        const result = await this.requireWorker().readVectors(
            presetId,
            memoryIds
        )
        if (result.missingMemoryIds.length > 0) {
            throw new LivingMemoryVectorIndexError(
                'vector-missing',
                'dirty',
                `vector index entries are missing: preset=${presetId}, ` +
                    `memoryIds=${result.missingMemoryIds.join(',')}`
            )
        }
        return result.vectors
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
        let state: MemoryVectorIndexState = 'dirty'
        if (error instanceof LivingMemoryVectorIndexError) {
            state = error.state
        } else if (this.workerFailure !== null || this.worker === null) {
            state = 'unavailable'
        }
        const expectedCount =
            await this.repository.countEntriesByPreset(presetId)
        if (this.worker !== null && this.workerFailure === null) {
            await this.worker.markPresetState({
                presetId,
                state,
                expectedCount,
                indexedCount,
                lastError: failure.message,
                updatedAt: Date.now()
            })
            await this.refreshInspection()
        } else {
            this.status.markFailure(state, failure.message)
        }
        return new LivingMemoryVectorIndexError(
            'mutation-failed',
            state,
            `vector index mutation failed: preset=${presetId}: ${failure.message}`,
            { cause: error }
        )
    }

    private async refreshInspection() {
        const inspection = await this.requireWorker().inspect()
        this.status.applyInspection(inspection)
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
        this.status.markMaintenanceFailure(state, failure.message)
        if (this.workerFailure === null) {
            this.logger.warn(failure)
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
            this.debug(
                `vector index failure inspection: ${summarizeError(error)}`
            )
        }
    }

    private recordWorkerFailure(error: Error) {
        this.stopping = true
        this.workerFailure = error
        this.status.markWorkerFailure(error)
        this.logger.warn(error)
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

    private debug(message: string) {
        if (this.config.debug) {
            this.logger.info(message)
        }
    }
}
