import { parentPort } from 'node:worker_threads'
import { type DreamHdbscanProgressReporter, runDreamHdbscan } from './algorithm'
import type {
    DreamHdbscanWorkerError,
    DreamHdbscanWorkerRequest,
    DreamHdbscanWorkerResponse
} from './protocol'

if (parentPort === null) {
    throw new Error('Dream HDBSCAN worker requires a parent port')
}
const workerPort = parentPort

const serializeError = (error: unknown): DreamHdbscanWorkerError => {
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

const run = (
    request: Extract<DreamHdbscanWorkerRequest, { type: 'run' }>
): Extract<DreamHdbscanWorkerResponse, { type: 'run' }> => {
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
            } satisfies DreamHdbscanWorkerResponse)
        }
    }
    const labels = runDreamHdbscan(
        { entryCount, dimension, vectors },
        progressReporter
    )
    return { id, type: 'run', ok: true, labels }
}

workerPort.on('message', (request: DreamHdbscanWorkerRequest) => {
    try {
        if (request.type === 'ready') {
            workerPort.postMessage({
                id: request.id,
                type: 'ready',
                ok: true
            } satisfies DreamHdbscanWorkerResponse)
            return
        }

        const response = run(request)
        workerPort.postMessage(response, [response.labels.buffer])
    } catch (error) {
        workerPort.postMessage({
            id: request.id,
            type: 'error',
            error: serializeError(error)
        } satisfies DreamHdbscanWorkerResponse)
    }
})
