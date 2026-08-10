import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { toError } from '../shared/utils'
import type {
    VectorIndexHybridQuery,
    VectorIndexKnnQuery,
    VectorIndexMutation,
    VectorIndexReplaceUpsert,
    VectorIndexWorkerCommand,
    VectorIndexWorkerCommandName,
    VectorIndexWorkerError,
    VectorIndexWorkerResponse,
    VectorIndexWorkerResult
} from './worker_protocol'
import type {
    MemoryVectorIndexManifest,
    MemoryVectorIndexPresetStatus
} from '../../contracts/vector_index'

interface PendingRequest {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
}

const resolveDefaultWorkerPath = () => {
    let moduleDirectory: string
    if (typeof __dirname !== 'undefined') {
        moduleDirectory = __dirname
    } else {
        moduleDirectory = dirname(fileURLToPath(import.meta.url))
    }
    return resolve(moduleDirectory, 'vector-index-worker.mjs')
}

const deserializeError = (serialized: VectorIndexWorkerError) => {
    const error = new Error(serialized.message)
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
        case 'queryKnn':
        case 'queryHybrid':
            return [command.vector.buffer]
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

    constructor(
        workerPath = resolveDefaultWorkerPath(),
        private readonly onFailure?: (error: Error) => void
    ) {
        this.worker = new Worker(workerPath)
        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve
        })
        this.worker.on('message', (response: VectorIndexWorkerResponse) => {
            this.handleResponse(response)
        })
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

    inspect() {
        return this.request({ type: 'inspect' })
    }

    queryKnn(query: VectorIndexKnnQuery) {
        return this.request({ type: 'queryKnn', ...query })
    }

    queryHybrid(query: VectorIndexHybridQuery) {
        return this.request({ type: 'queryHybrid', ...query })
    }

    readVectors(presetId: string, memoryIds: string[]) {
        return this.request({ type: 'readVectors', presetId, memoryIds })
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

    markPresetState(status: MemoryVectorIndexPresetStatus) {
        return this.request({ type: 'markPresetState', ...status })
    }

    createRebuildFile(
        databaseDirectory: string,
        manifest: MemoryVectorIndexManifest
    ) {
        return this.request({
            type: 'createRebuildFile',
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

    finalizeRebuild(
        previousDatabaseDirectory: string,
        expectedCount: number
    ) {
        return this.request({
            type: 'finalizeRebuild',
            previousDatabaseDirectory,
            expectedCount
        })
    }

    abortRebuild() {
        return this.request({ type: 'abortRebuild' })
    }

    async dispose() {
        this.disposeRequested = true
        await this.request({ type: 'dispose' })
        const exitCode = await this.exitPromise
        if (exitCode !== 0) {
            throw new Error(
                `vector index worker dispose failed: exitCode=${exitCode}`
            )
        }
    }

    private request<Name extends VectorIndexWorkerCommandName>(
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
