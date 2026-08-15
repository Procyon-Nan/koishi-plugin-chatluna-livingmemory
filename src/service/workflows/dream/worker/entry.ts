import { parentPort } from 'node:worker_threads'
import {
    type DreamHdbscanProgressReporter,
    runDreamHdbscan
} from '../hdbscan/algorithm'
import { partitionDreamEntries } from '../partitioning'
import type {
    DreamWorkerError,
    DreamWorkerRequest,
    DreamWorkerResponse
} from './protocol'

if (parentPort === null) {
    throw new Error('Dream worker requires a parent port')
}
const workerPort = parentPort

const serializeError = (error: unknown): DreamWorkerError => {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack ?? null
        }
    }
    return {
        name: 'Error',
        message: String(error),
        stack: null
    }
}

const partition = (
    request: Extract<DreamWorkerRequest, { type: 'partition' }>
): Extract<DreamWorkerResponse, { type: 'partition' }> => {
    const entries = request.entries.map((entry, index) => ({ ...entry, index }))
    const partitions = partitionDreamEntries(entries, {
        targetSize: request.targetSize
    }).map((items) => items.map((entry) => entry.index))
    return { id: request.id, type: 'partition', ok: true, partitions }
}

const runHdbscan = (
    request: Extract<DreamWorkerRequest, { type: 'hdbscan' }>
): Extract<DreamWorkerResponse, { type: 'hdbscan' }> => {
    const { id, entryCount, dimension, vectors, reportProgress } = request
    if (vectors.length !== entryCount * dimension) {
        throw new Error(
            `Dream HDBSCAN matrix shape mismatch: entries=${entryCount}, dimension=${dimension}, values=${vectors.length}`
        )
    }

    const startedAt = performance.now()
    let progressReporter: DreamHdbscanProgressReporter | undefined
    if (reportProgress) {
        progressReporter = ({ phase, completed, total }) => {
            workerPort.postMessage({
                id,
                type: 'progress',
                progress: {
                    phase,
                    completed,
                    total,
                    elapsedMs: performance.now() - startedAt
                }
            } satisfies DreamWorkerResponse)
        }
    }
    const labels = runDreamHdbscan(
        { entryCount, dimension, vectors },
        progressReporter
    )
    return { id, type: 'hdbscan', ok: true, labels }
}

workerPort.on('message', (request: DreamWorkerRequest) => {
    try {
        if (request.type === 'ready') {
            workerPort.postMessage({
                id: request.id,
                type: 'ready',
                ok: true
            } satisfies DreamWorkerResponse)
            return
        }

        if (request.type === 'partition') {
            workerPort.postMessage(partition(request))
            return
        }

        const response = runHdbscan(request)
        workerPort.postMessage(response, [response.labels.buffer])
    } catch (error) {
        workerPort.postMessage({
            id: request.id,
            type: 'error',
            error: serializeError(error)
        } satisfies DreamWorkerResponse)
    }
})
