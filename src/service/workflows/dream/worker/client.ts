import { Worker } from 'node:worker_threads'
import { resolveWorkerArtifact } from '../../../../worker_artifacts'
import { toError } from '../../../shared/utils'
import type { DreamHdbscanMatrix } from '../hdbscan/algorithm'
import type { DreamPartitionEntry } from '../partitioning/types'
import type {
    DreamHdbscanProgressHandler,
    DreamWorkerCommand,
    DreamWorkerError,
    DreamWorkerResponse,
    DreamWorkerRunner
} from './protocol'

interface PendingRequest {
    resolve: (response: DreamWorkerResponse) => void
    reject: (error: Error) => void
    onProgress?: DreamHdbscanProgressHandler
}

const deserializeError = (serialized: DreamWorkerError) => {
    const error = new Error(serialized.message)
    error.name = serialized.name
    if (serialized.stack !== null) {
        error.stack = serialized.stack
    }
    return error
}

export interface DreamWorkerClientOptions {
    workerPath?: string
    onFailure?: (error: Error) => void
}

export class LivingMemoryDreamWorkerClient implements DreamWorkerRunner {
    private readonly workerPath: string
    private readonly onFailure?: (error: Error) => void
    private worker: Worker | null = null
    private readonly pending = new Map<number, PendingRequest>()
    private nextRequestId = 1
    private failure: Error | null = null
    private closed = false

    constructor(options: DreamWorkerClientOptions = {}) {
        this.workerPath =
            options.workerPath ??
            resolveWorkerArtifact('dream-hdbscan-worker.mjs')
        this.onFailure = options.onFailure
    }

    async start() {
        if (this.closed) {
            throw new Error('Dream worker is stopped')
        }
        if (this.worker !== null) {
            throw new Error('Dream worker is already started')
        }

        this.worker = new Worker(this.workerPath)
        this.worker.on('message', (response: DreamWorkerResponse) => {
            this.handleResponse(response)
        })
        this.worker.on('error', (error: Error) => {
            this.fail(error)
        })
        this.worker.on('exit', (code) => {
            if (!this.closed) {
                this.fail(
                    new Error(`Dream worker exited unexpectedly: code=${code}`)
                )
            }
        })

        await this.request({ type: 'ready' })
    }

    async partition<Entry extends DreamPartitionEntry>(
        entries: readonly Entry[]
    ): Promise<Entry[][]> {
        const response = await this.request({
            type: 'partition',
            entries: entries.map(({ id, keywords }) => ({ id, keywords }))
        })
        if (response.type !== 'partition') {
            throw new Error(
                `unexpected Dream worker response: ${response.type}`
            )
        }
        return response.partitions.map((partition) =>
            partition.map((entryIndex) => entries[entryIndex])
        )
    }

    async runHdbscan(
        matrix: DreamHdbscanMatrix,
        onProgress?: DreamHdbscanProgressHandler
    ) {
        const response = await this.request(
            {
                type: 'hdbscan',
                entryCount: matrix.entryCount,
                dimension: matrix.dimension,
                vectors: matrix.vectors,
                reportProgress: onProgress !== undefined
            },
            [matrix.vectors.buffer],
            onProgress
        )
        if (response.type !== 'hdbscan') {
            throw new Error(
                `unexpected Dream worker response: ${response.type}`
            )
        }
        return response.labels
    }

    async stop() {
        const worker = this.worker
        if (worker === null) {
            return
        }

        this.closed = true
        this.worker = null
        const error = new Error('Dream worker stopped')
        for (const pending of this.pending.values()) {
            pending.reject(error)
        }
        this.pending.clear()
        await worker.terminate()
    }

    private request(
        request: DreamWorkerCommand,
        transferList: ArrayBuffer[] = [],
        onProgress?: DreamHdbscanProgressHandler
    ) {
        if (this.failure !== null) {
            return Promise.reject(this.failure)
        }
        if (this.worker === null) {
            return Promise.reject(new Error('Dream worker is not started'))
        }

        const id = this.nextRequestId++
        const worker = this.worker
        return new Promise<DreamWorkerResponse>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onProgress })
            try {
                worker.postMessage({ id, ...request }, transferList)
            } catch (error) {
                this.pending.delete(id)
                reject(toError(error))
            }
        })
    }

    private handleResponse(response: DreamWorkerResponse) {
        const pending = this.pending.get(response.id)
        if (pending === undefined) {
            return
        }
        if (response.type === 'progress') {
            pending.onProgress?.(response.progress)
            return
        }
        this.pending.delete(response.id)
        if (response.type === 'error') {
            pending.reject(deserializeError(response.error))
        } else {
            pending.resolve(response)
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
