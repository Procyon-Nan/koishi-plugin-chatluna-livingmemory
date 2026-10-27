import { Worker } from 'node:worker_threads'
import { resolveWorkerArtifact } from '../../worker_artifacts'
import { toError } from '../shared/utils'
import { LivingMemoryVectorIndexError } from './errors'
import type {
    VectorIndexHybridQuery,
    VectorIndexMutation,
    VectorIndexPresetStateMark,
    VectorIndexReplaceUpsert,
    VectorIndexWorkerCommand,
    VectorIndexWorkerCommandName,
    VectorIndexWorkerError,
    VectorIndexWorkerResponse,
    VectorIndexWorkerWarning,
    VectorIndexWorkerResult
} from './worker_protocol'
import type {
    DreamNeighborQuery,
    MemoryVectorIndexManifest
} from '../../contracts/vector_index'

interface PendingRequest {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
}

const deserializeError = (serialized: VectorIndexWorkerError) => {
    let error: Error
    if (serialized.code === null || serialized.state === null) {
        error = new Error(serialized.message)
    } else {
        error = new LivingMemoryVectorIndexError(
            serialized.code,
            serialized.state,
            serialized.message
        )
    }
    error.name = serialized.name
    if (serialized.stack !== null) {
        error.stack = serialized.stack
    }
    return error
}

const uniqueBuffers = (buffers: ArrayBuffer[]) => [...new Set(buffers)]

const commandTransferList = (
    command: VectorIndexWorkerCommand
): ArrayBuffer[] => {
    switch (command.type) {
        case 'queryHybrid':
            return [command.vector.buffer]
        case 'queryDreamNeighbors':
            return uniqueBuffers(
                command.queries.map((query) => query.vector.buffer)
            )
        case 'applyMutation':
            return uniqueBuffers(
                command.upserts.flatMap((upsert) => {
                    if (upsert.vectorAction === 'replace') {
                        return [upsert.vector.buffer]
                    }
                    return []
                })
            )
        case 'appendRebuildBatch':
            return uniqueBuffers(
                command.upserts.map((upsert) => upsert.vector.buffer)
            )
        default:
            return []
    }
}

export class LivingMemoryVectorIndexWorkerClient {
    private readonly worker: Worker
    private readonly pending = new Map<number, PendingRequest>()
    private readonly exitPromise: Promise<number>
    private resolveExit!: (code: number) => void
    private nextRequestId = 1
    private failure: Error | null = null
    private disposeRequested = false
    private disposePromise: Promise<void> | null = null

    constructor(
        workerPath = resolveWorkerArtifact('vector-index-worker.mjs'),
        private readonly onFailure?: (error: Error) => void,
        private readonly onWarning?: (error: Error) => void
    ) {
        this.worker = new Worker(workerPath)
        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve
        })
        this.worker.on(
            'message',
            (
                response: VectorIndexWorkerResponse | VectorIndexWorkerWarning
            ) => {
                if (response.type === 'warning') {
                    this.onWarning?.(deserializeError(response.error))
                    return
                }
                this.handleResponse(response)
            }
        )
        this.worker.on('error', (error: Error) => {
            this.fail(error)
        })
        this.worker.on('exit', (code) => {
            this.resolveExit(code)
            if (!this.disposeRequested || this.pending.size > 0) {
                this.fail(
                    new Error(
                        `vector index worker exited unexpectedly: code=${code}`
                    )
                )
            }
        })
    }

    open(databaseDirectory: string, previousDatabaseDirectory: string) {
        return this.request({
            type: 'open',
            databaseDirectory,
            previousDatabaseDirectory
        })
    }

    openCandidate(databaseDirectory: string) {
        return this.request({ type: 'openCandidate', databaseDirectory })
    }

    inspect() {
        return this.request({ type: 'inspect' })
    }

    upgradeSchema() {
        return this.request({ type: 'upgradeSchema' })
    }

    queryHybrid(query: VectorIndexHybridQuery) {
        return this.request({ type: 'queryHybrid', ...query })
    }

    readVectorSnapshot(presetId: string, memoryIds: string[]) {
        return this.request({ type: 'readVectorSnapshot', presetId, memoryIds })
    }

    buildDreamAnnIndex() {
        return this.request({ type: 'buildDreamAnnIndex' })
    }

    async queryDreamNeighbors(
        queries: DreamNeighborQuery[],
        signal?: AbortSignal
    ) {
        signal?.throwIfAborted()
        const cancellation = new Int32Array(new SharedArrayBuffer(4))
        const cancel = () => Atomics.store(cancellation, 0, 1)
        signal?.addEventListener('abort', cancel, { once: true })
        try {
            const result = await this.request({
                type: 'queryDreamNeighbors',
                queries,
                cancellation
            })
            signal?.throwIfAborted()
            return result
        } finally {
            signal?.removeEventListener('abort', cancel)
        }
    }

    applyMutation(mutation: VectorIndexMutation) {
        return this.request({ type: 'applyMutation', ...mutation })
    }

    clearPreset(presetId: string) {
        return this.request({ type: 'clearPreset', presetId })
    }

    readInventoryPage(
        presetId: string | null,
        afterMemoryId: string | null,
        limit: number
    ) {
        return this.request({
            type: 'readInventoryPage',
            presetId,
            afterMemoryId,
            limit
        })
    }

    markPresetState(status: VectorIndexPresetStateMark) {
        return this.request({ type: 'markPresetState', ...status })
    }

    openRebuildDatabase(
        databaseDirectory: string,
        manifest: MemoryVectorIndexManifest
    ) {
        return this.request({
            type: 'openRebuildDatabase',
            databaseDirectory,
            manifest
        })
    }

    appendRebuildBatch(presetId: string, upserts: VectorIndexReplaceUpsert[]) {
        return this.request({
            type: 'appendRebuildBatch',
            presetId,
            upserts
        })
    }

    validateAndCloseRebuildDatabase(expectedCount: number) {
        return this.request({
            type: 'validateAndCloseRebuildDatabase',
            expectedCount
        })
    }

    closeDatabase() {
        return this.request({ type: 'closeDatabase' })
    }

    abortRebuild() {
        return this.request({ type: 'abortRebuild' })
    }

    async dispose() {
        if (this.disposePromise === null) {
            this.disposePromise = this.disposeWorker()
        }
        return this.disposePromise
    }

    private async disposeWorker() {
        this.disposeRequested = true
        let disposeError: Error | null = null
        try {
            await this.sendRequest({ type: 'dispose' })
        } catch (error) {
            disposeError = toError(error)
            await this.worker.terminate()
        }
        const exitCode = await this.exitPromise
        if (disposeError !== null) {
            throw disposeError
        }
        if (exitCode !== 0) {
            throw new Error(
                `vector index worker dispose failed: exitCode=${exitCode}`
            )
        }
    }

    private request<Name extends VectorIndexWorkerCommandName>(
        command: VectorIndexWorkerCommand<Name>
    ): Promise<VectorIndexWorkerResult<Name>> {
        if (this.disposeRequested) {
            return Promise.reject(
                new LivingMemoryVectorIndexError(
                    'worker-unavailable',
                    'unavailable',
                    'vector index worker is stopping'
                )
            )
        }
        return this.sendRequest(command)
    }

    private sendRequest<Name extends VectorIndexWorkerCommandName>(
        command: VectorIndexWorkerCommand<Name>
    ): Promise<VectorIndexWorkerResult<Name>> {
        if (this.failure !== null) {
            return Promise.reject(this.failure)
        }

        const id = this.nextRequestId++
        return new Promise<VectorIndexWorkerResult<Name>>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (result: unknown) => void,
                reject
            })
            try {
                this.worker.postMessage(
                    { id, command },
                    commandTransferList(command)
                )
            } catch (error) {
                this.pending.delete(id)
                reject(toError(error))
            }
        })
    }

    private handleResponse(response: VectorIndexWorkerResponse) {
        const pending = this.pending.get(response.id)
        if (pending === undefined) {
            return
        }
        this.pending.delete(response.id)
        if (response.ok === true) {
            pending.resolve(response.result)
        } else {
            pending.reject(deserializeError(response.error))
        }
    }

    private fail(error: Error) {
        if (this.failure === null) {
            this.failure = error
            this.onFailure?.(error)
        }
        for (const pending of this.pending.values()) {
            pending.reject(this.failure)
        }
        this.pending.clear()
    }
}
