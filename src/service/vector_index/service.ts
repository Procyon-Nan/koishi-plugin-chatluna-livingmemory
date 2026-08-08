import { resolve } from 'node:path'
import type { Context, Logger } from 'koishi'
import type {
    IncrementalDreamNeighborInput,
    IncrementalDreamNeighborSearch,
    LegacyMemoryEmbeddingRecord,
    ManualDreamVectorReader,
    MemoryHybridSearchHit,
    MemoryHybridSearchInput,
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink,
    MemorySemanticSearchInput,
    MemoryVectorIndexPresetStatus,
    MemoryVectorIndexState,
    MemoryVectorIndexStatus,
    MemoryVectorSearch,
    MemoryVectorSearchHit
} from '../../contracts/vector_index'
import { summarizeError } from '../shared/utils'
import { LivingMemoryVectorIndexError } from './errors'
import {
    LivingMemoryVectorIndexMaintenance,
    type LivingMemoryVectorIndexRepository
} from './maintenance'
import { createVectorIndexDocument } from './documents'
import {
    createVectorIndexVector,
    embedMemoryIndexSources,
    type VectorIndexEmbeddingContext
} from './embedding'
import {
    VectorIndexOperationGate,
    VectorIndexPresetMutationQueue
} from './operation_gate'
import { LivingMemoryVectorIndexOwnershipLock } from './ownership_lock'
import { VECTOR_INDEX_SCHEMA_VERSION } from './worker/schema'
import { LivingMemoryVectorIndexWorkerClient } from './worker_client'
import type {
    VectorIndexInspection,
    VectorIndexUpsert
} from './worker_protocol'

const NO_LEGACY_EMBEDDINGS = new Map<string, LegacyMemoryEmbeddingRecord>()

export type VectorIndexWorkerFactory = (
    onFailure: (error: Error) => void
) => LivingMemoryVectorIndexWorkerClient

interface VectorIndexServiceOptions {
    schemaVersion?: number
    workerFactory?: VectorIndexWorkerFactory
}

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
    private status: MemoryVectorIndexStatus = {
        state: 'unavailable',
        manifest: null,
        presets: [],
        currentJobId: null,
        lastError: null
    }

    constructor(
        ctx: Context,
        private readonly config: { embeddingModel: string; debug: boolean },
        private readonly repository: LivingMemoryVectorIndexRepository,
        private readonly logger: Logger,
        options: VectorIndexServiceOptions = {}
    ) {
        let schemaVersion = VECTOR_INDEX_SCHEMA_VERSION
        if (options.schemaVersion !== undefined) {
            schemaVersion = options.schemaVersion
        }
        this.workerFactory = this.createWorkerFactory(options.workerFactory)

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
            onCurrentJobChanged: (jobId) => {
                this.status = { ...this.status, currentJobId: jobId }
            },
            onInspection: (inspection) => this.applyInspection(inspection),
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
            const failure = this.toError(error)
            this.status = {
                ...this.status,
                state: 'unavailable',
                lastError: failure.message
            }
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
            openError = this.toError(error)
        }

        let lastError: string | null = null
        if (openError !== null) {
            lastError = openError.message
        }
        this.status = {
            ...this.status,
            state: 'building',
            lastError
        }
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
                this.debug(
                    `vector index worker disposal: ${summarizeError(error)}`
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
        this.status = {
            state: 'unavailable',
            manifest: null,
            presets: [],
            currentJobId: null,
            lastError: null
        }
        await this.start()
    }

    getStatus(): MemoryVectorIndexStatus {
        let manifest = null
        if (this.status.manifest !== null) {
            manifest = { ...this.status.manifest }
        }
        return {
            ...this.status,
            manifest,
            presets: this.status.presets.map((preset) => ({ ...preset }))
        }
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
        return await this.runPresetMutation(input.presetId, async () => {
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
            let indexedCount = this.getPresetIndexedCount(batch.presetId)
            try {
                const mutation = await this.createWorkerMutation(batch)
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
            let indexedCount = this.getPresetIndexedCount(presetId)
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

    private async rebuild(reason: string) {
        await this.queueMaintenance(async () => {
            try {
                await this.maintenance.rebuild(reason)
            } catch (error) {
                await this.handleMaintenanceFailure(error)
            }
        })
    }

    startRebuild(reason: string) {
        this.status = {
            ...this.status,
            state: 'building',
            currentJobId: null,
            lastError: null
        }
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

    private async createWorkerMutation(batch: MemoryIndexMutationBatch) {
        const context = this.requireEmbeddingContext()
        const replacementSources = batch.upserts
            .filter((upsert) => upsert.vectorAction === 'replace')
            .map((upsert) => upsert.document)
        const replacements = await embedMemoryIndexSources(
            context.embeddings,
            context.embeddingModelId,
            context.dimension,
            replacementSources,
            NO_LEGACY_EMBEDDINGS
        )
        let replacementIndex = 0
        const upserts: VectorIndexUpsert[] = batch.upserts.map((upsert) => {
            if (upsert.vectorAction === 'preserve') {
                return {
                    vectorAction: 'preserve',
                    document: createVectorIndexDocument(upsert.document)
                }
            }
            const replacement = replacements[replacementIndex++]
            return {
                vectorAction: 'replace',
                document: createVectorIndexDocument(replacement.source),
                vector: replacement.vector
            }
        })
        return {
            presetId: batch.presetId,
            upserts,
            deletes: batch.deletes.map((item) => item.id)
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
        if (this.status.state !== 'ready') {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                this.status.state,
                `vector index is not ready: state=${this.status.state}`
            )
        }
        const preset = this.status.presets.find(
            (item) => item.presetId === presetId
        )
        if (preset !== undefined && preset.state !== 'ready') {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                preset.state,
                `vector index preset is not ready: preset=${presetId}, state=${preset.state}`
            )
        }
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
        const failure = this.toError(error)
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
            this.status = {
                ...this.status,
                state,
                lastError: failure.message
            }
        }
        return new LivingMemoryVectorIndexError(
            'mutation-failed',
            state,
            `vector index mutation failed: preset=${presetId}: ${failure.message}`,
            { cause: error }
        )
    }

    private getPresetIndexedCount(presetId: string) {
        const preset = this.status.presets.find(
            (item) => item.presetId === presetId
        )
        if (preset === undefined) {
            return 0
        }
        return preset.indexedCount
    }

    private async refreshInspection() {
        const inspection = await this.requireWorker().inspect()
        this.applyInspection(inspection)
    }

    private createWorkerFactory(factory?: VectorIndexWorkerFactory) {
        if (factory !== undefined) {
            return factory
        }
        return (onFailure: (error: Error) => void) =>
            new LivingMemoryVectorIndexWorkerClient(undefined, onFailure)
    }

    private markBuilding(jobId: string) {
        const updatedAt = Date.now()
        this.status = {
            ...this.status,
            state: 'building',
            presets: this.status.presets.map((preset) => ({
                ...preset,
                state: 'building',
                lastError: null,
                updatedAt
            })),
            currentJobId: jobId,
            lastError: null
        }
    }

    private markPresetBuilding(
        presetId: string,
        jobId: string,
        expectedCount: number
    ) {
        const updatedAt = Date.now()
        const presets: MemoryVectorIndexPresetStatus[] =
            this.status.presets.map((preset) => {
                if (preset.presetId !== presetId) {
                    return preset
                }
                return {
                    ...preset,
                    state: 'building',
                    expectedCount,
                    lastError: null,
                    updatedAt
                }
            })
        if (!presets.some((preset) => preset.presetId === presetId)) {
            presets.push({
                presetId,
                state: 'building',
                expectedCount,
                indexedCount: 0,
                lastError: null,
                updatedAt
            })
        }
        this.status = {
            ...this.status,
            state: 'building',
            presets,
            currentJobId: jobId,
            lastError: null
        }
    }

    private applyInspection(inspection: VectorIndexInspection) {
        const state = this.resolveInspectionState(inspection)
        const failedPreset = inspection.presets.find(
            (preset) => preset.lastError !== null
        )
        let lastError: string | null = null
        if (failedPreset !== undefined) {
            lastError = failedPreset.lastError
        }
        this.status = {
            state,
            manifest: inspection.manifest,
            presets: inspection.presets,
            currentJobId: this.status.currentJobId,
            lastError
        }
    }

    private resolveInspectionState(
        inspection: VectorIndexInspection
    ): MemoryVectorIndexState {
        if (inspection.manifest === null) {
            return 'building'
        }
        if (inspection.presets.some((preset) => preset.state === 'dirty')) {
            return 'dirty'
        }
        if (inspection.presets.some((preset) => preset.state === 'building')) {
            return 'building'
        }
        if (
            inspection.presets.some((preset) => preset.state === 'unavailable')
        ) {
            return 'unavailable'
        }
        return 'ready'
    }

    private async awaitPresetReadBarrier(presetId: string) {
        await this.presetMutationQueue.wait(presetId)
        this.assertPresetReady(presetId)
    }

    private async handleMaintenanceFailure(error: unknown) {
        const failure = this.toError(error)
        let state: MemoryVectorIndexState = 'unavailable'
        if (
            this.workerFailure === null &&
            error instanceof LivingMemoryVectorIndexError
        ) {
            state = error.state
        }
        await this.inspectAfterFailure()
        this.status = {
            ...this.status,
            state,
            currentJobId: null,
            lastError: failure.message
        }
        this.logger.warn(failure)
    }

    private async inspectAfterFailure() {
        if (this.workerFailure !== null || this.worker === null) {
            return
        }
        try {
            const inspection = await this.worker.inspect()
            this.applyInspection(inspection)
        } catch (error) {
            this.debug(
                `vector index failure inspection: ${summarizeError(error)}`
            )
        }
    }

    private recordWorkerFailure(error: Error) {
        this.stopping = true
        this.workerFailure = error
        this.status = {
            ...this.status,
            state: 'unavailable',
            presets: this.status.presets.map((preset) => ({
                ...preset,
                state: 'unavailable',
                lastError: error.message,
                updatedAt: Date.now()
            })),
            lastError: error.message
        }
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

    private toError(error: unknown) {
        if (error instanceof Error) {
            return error
        }
        return new Error(String(error))
    }

    private debug(message: string) {
        if (this.config.debug) {
            this.logger.info(message)
        }
    }
}
