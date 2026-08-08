import { resolve } from 'node:path'
import type { Context, Logger } from 'koishi'
import type {
    ManualDreamVectorReader,
    MemoryVectorIndexStatus,
    MemoryVectorIndexState
} from '../../contracts/vector_index'
import { summarizeError } from '../shared/utils'
import { LivingMemoryVectorIndexError } from './errors'
import {
    LivingMemoryVectorIndexMaintenance,
    type LivingMemoryVectorIndexRepository
} from './maintenance'
import {
    VectorIndexOperationGate,
    VectorIndexPresetMutationQueue
} from './operation_gate'
import { LivingMemoryVectorIndexOwnershipLock } from './ownership_lock'
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

export class LivingMemoryVectorIndexService implements ManualDreamVectorReader {
    private readonly operationGate = new VectorIndexOperationGate()
    private readonly presetMutationQueue =
        new VectorIndexPresetMutationQueue(this.operationGate)
    private readonly databasePath: string
    private readonly previousDatabasePath: string
    private readonly ownershipLock: LivingMemoryVectorIndexOwnershipLock
    private readonly maintenance: LivingMemoryVectorIndexMaintenance
    private readonly workerFactory: VectorIndexWorkerFactory
    private worker: LivingMemoryVectorIndexWorkerClient | null = null
    private initialization: Promise<void> | null = null
    private maintenanceTail: Promise<void> = Promise.resolve()
    private workerFailure: Error | null = null
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
        repository: LivingMemoryVectorIndexRepository,
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
    ): Promise<Map<string, number[]>> {
        await this.awaitPresetReadBarrier(presetId)
        const result = await this.requireWorker().readVectors(
            presetId,
            memoryIds
        )
        const vectors = new Map<string, number[]>()
        for (const item of result.vectors) {
            vectors.set(item.memoryId, [...item.vector])
        }
        return vectors
    }

    runPresetMutation<T>(presetId: string, task: () => Promise<T>) {
        return this.presetMutationQueue.run(presetId, task)
    }

    async rebuild(reason: string) {
        await this.queueMaintenance(async () => {
            try {
                await this.maintenance.rebuild(reason)
            } catch (error) {
                await this.handleMaintenanceFailure(error)
                throw error
            }
        })
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
        if (
            inspection.presets.some((preset) => preset.state === 'building')
        ) {
            return 'building'
        }
        if (
            inspection.presets.some(
                (preset) => preset.state === 'unavailable'
            )
        ) {
            return 'unavailable'
        }
        return 'ready'
    }

    private async awaitPresetReadBarrier(presetId: string) {
        await this.presetMutationQueue.wait(presetId)
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
