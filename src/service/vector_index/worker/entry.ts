import { parentPort } from 'node:worker_threads'
import type {
    VectorIndexWorkerError,
    VectorIndexWorkerRequest,
    VectorIndexWorkerResponse
} from '../worker_protocol'
import { LivingMemoryVectorIndexDatabase } from './database'

if (parentPort === null) {
    throw new Error('vector index worker requires a parent port')
}

const database = new LivingMemoryVectorIndexDatabase()

const serializeError = (error: unknown): VectorIndexWorkerError => {
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

const execute = (
    request: VectorIndexWorkerRequest
): VectorIndexWorkerResponse => {
    const { id, command } = request
    try {
        switch (command.type) {
            case 'open':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.open(command.databasePath)
                }
            case 'inspect':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.inspect()
                }
            case 'queryKnn':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.queryKnn(command)
                }
            case 'queryHybrid':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.queryHybrid(command)
                }
            case 'readVectors':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.readVectors(
                        command.presetId,
                        command.memoryIds
                    )
                }
            case 'applyMutation':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.applyMutation(command)
                }
            case 'clearPreset':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.clearPreset(command.presetId)
                }
            case 'readInventoryPage':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.readInventoryPage(
                        command.presetId,
                        command.afterMemoryId,
                        command.limit
                    )
                }
            case 'markPresetState':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.markPresetState(command)
                }
            case 'createRebuildFile':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.createRebuildFile(
                        command.databasePath,
                        command.manifest
                    )
                }
            case 'appendRebuildBatch':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.appendRebuildBatch(
                        command.presetId,
                        command.upserts
                    )
                }
            case 'finalizeRebuild':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.finalizeRebuild(
                        command.previousDatabasePath,
                        command.expectedCount
                    )
                }
            case 'abortRebuild':
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: database.abortRebuild()
                }
            case 'dispose':
                database.dispose()
                return {
                    id,
                    type: command.type,
                    ok: true,
                    result: { disposed: true }
                }
        }
    } catch (error) {
        return {
            id,
            type: command.type,
            ok: false,
            error: serializeError(error)
        } as VectorIndexWorkerResponse
    }
}

const responseTransferList = (response: VectorIndexWorkerResponse) => {
    if (!response.ok || response.type !== 'readVectors') {
        return []
    }
    return response.result.vectors.map(({ vector }) => vector.buffer)
}

parentPort.on('message', (request: VectorIndexWorkerRequest) => {
    const response = execute(request)
    parentPort.postMessage(response, responseTransferList(response))
    if (response.ok && response.type === 'dispose') {
        parentPort.close()
    }
})
