import { parentPort } from 'node:worker_threads'
import { bisectDreamMemories } from '../semantic/bisect'
import { refineDreamMemories } from '../semantic/refine'
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

        if (request.type === 'bisect') {
            const startedAt = performance.now()
            const reportProgress = (completed: number, total: number) => {
                workerPort.postMessage({
                    id: request.id,
                    type: 'progress',
                    progress: {
                        phase: 'bisect',
                        completed,
                        total,
                        elapsedMs: performance.now() - startedAt
                    }
                } satisfies DreamWorkerResponse)
            }
            const result = bisectDreamMemories(
                request,
                request.reportProgress ? reportProgress : undefined
            )
            workerPort.postMessage(
                {
                    id: request.id,
                    type: 'bisect',
                    ok: true,
                    result
                } satisfies DreamWorkerResponse,
                [
                    result.matrix.vectors.buffer,
                    result.plan.labels.buffer,
                    result.plan.sizes.buffer
                ]
            )
            return
        }

        if (request.type === 'refine') {
            const result = refineDreamMemories(request)
            workerPort.postMessage(
                {
                    id: request.id,
                    type: 'refine',
                    ok: true,
                    result
                } satisfies DreamWorkerResponse,
                result.outcome === 'refined'
                    ? [result.plan.labels.buffer, result.plan.sizes.buffer]
                    : []
            )
            return
        }
    } catch (error) {
        workerPort.postMessage({
            id: request.id,
            type: 'error',
            error: serializeError(error)
        } satisfies DreamWorkerResponse)
    }
})
