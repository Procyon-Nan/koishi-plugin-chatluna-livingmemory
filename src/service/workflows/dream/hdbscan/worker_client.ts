import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { toError } from '../../../shared/utils'
import type { DreamHdbscanMatrix } from './algorithm'
import type {
    DreamHdbscanProgressHandler,
    DreamHdbscanRunner,
    DreamHdbscanWorkerCommand,
    DreamHdbscanWorkerError,
    DreamHdbscanWorkerResponse
} from './protocol'

interface PendingRequest {
    resolve: (response: DreamHdbscanWorkerResponse) => void
    reject: (error: Error) => void
    onProgress?: DreamHdbscanProgressHandler
}

const resolveDefaultWorkerPath = () => {
    let moduleDirectory: string
    if (typeof __dirname !== 'undefined') {
        moduleDirectory = __dirname
    } else {
        moduleDirectory = dirname(fileURLToPath(import.meta.url))
    }
    return resolve(moduleDirectory, 'dream-hdbscan-worker.mjs')
}

const deserializeError = (serialized: DreamHdbscanWorkerError) => {
    const error = new Error(serialized.message)
    error.name = serialized.name
    if (serialized.stack !== null) {
        error.stack = serialized.stack
    }
    return error
}

export interface DreamHdbscanWorkerClientOptions {
    workerPath?: string
    onFailure?: (error: Error) => void
}

export class LivingMemoryDreamHdbscanWorkerClient implements DreamHdbscanRunner {
    private readonly workerPath: string
    private readonly onFailure?: (error: Error) => void
    private worker: Worker | null = null
    private readonly pending = new Map<number, PendingRequest>()
    private nextRequestId = 1
    private failure: Error | null = null
    private closed = false

    constructor(options: DreamHdbscanWorkerClientOptions = {}) {
        this.workerPath = options.workerPath ?? resolveDefaultWorkerPath()
        this.onFailure = options.onFailure
    }

    async start() {
        if (this.closed) {
            throw new Error('Dream HDBSCAN worker is stopped')
        }
        if (this.worker !== null) {
            throw new Error('Dream HDBSCAN worker is already started')
        }

        this.worker = new Worker(this.workerPath)
        this.worker.on('message', (response: DreamHdbscanWorkerResponse) => {
            this.handleResponse(response)
        })
        this.worker.on('error', (error) => {
            this.fail(error)
        })
        this.worker.on('exit', (code) => {
            if (!this.closed) {
                this.fail(
                    new Error(
                        `Dream HDBSCAN worker exited unexpectedly: code=${code}`
                    )
                )
            }
        })

        await this.request({ type: 'ready' })
    }

    async run(
        matrix: DreamHdbscanMatrix,
        onProgress?: DreamHdbscanProgressHandler
    ) {
        const response = await this.request(
            {
                type: 'run',
                entryCount: matrix.entryCount,
                dimension: matrix.dimension,
                vectors: matrix.vectors,
                reportProgress: onProgress !== undefined
            },
            [matrix.vectors.buffer],
            onProgress
        )
        if (response.type !== 'run') {
            throw new Error(
                `unexpected Dream HDBSCAN worker response: ${response.type}`
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
        const error = new Error('Dream HDBSCAN worker stopped')
        for (const pending of this.pending.values()) {
            pending.reject(error)
        }
        this.pending.clear()
        await worker.terminate()
    }

    private request(
        request: DreamHdbscanWorkerCommand,
        transferList: ArrayBuffer[] = [],
        onProgress?: DreamHdbscanProgressHandler
    ) {
        if (this.failure !== null) {
            return Promise.reject(this.failure)
        }
        if (this.worker === null) {
            return Promise.reject(
                new Error('Dream HDBSCAN worker is not started')
            )
        }

        const id = this.nextRequestId++
        const worker = this.worker
        return new Promise<DreamHdbscanWorkerResponse>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onProgress })
            try {
                worker.postMessage({ id, ...request }, transferList)
            } catch (error) {
                this.pending.delete(id)
                reject(toError(error))
            }
        })
    }

    private handleResponse(response: DreamHdbscanWorkerResponse) {
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
