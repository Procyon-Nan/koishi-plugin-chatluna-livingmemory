import type {
    VectorIndexWorkerError,
    VectorIndexWorkerRequest,
    VectorIndexWorkerResponse
} from '../worker_protocol'
import type { LivingMemoryVectorIndexDatabase } from './database'

interface VectorIndexWorkerPort {
    on(
        event: 'message',
        listener: (request: VectorIndexWorkerRequest) => void
    ): unknown
    postMessage(
        response: VectorIndexWorkerResponse,
        transferList: ArrayBuffer[]
    ): void
    close(): void
}

const serializeError = (error: unknown): VectorIndexWorkerError => {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack ?? null
        }
    }
    return { name: 'Error', message: String(error), stack: null }
}

const execute = async (
    database: LivingMemoryVectorIndexDatabase,
    request: VectorIndexWorkerRequest
): Promise<VectorIndexWorkerResponse> => {
    const { id, command } = request
    try {
        let result: unknown
        switch (command.type) {
            case 'open':
                result = await database.open(
                    command.databaseDirectory,
                    command.previousDatabaseDirectory
                )
                break
            case 'inspect':
                result = await database.inspect()
                break
            case 'queryKnn':
                result = await database.queryKnn(command)
                break
            case 'queryHybrid':
                result = await database.queryHybrid(command)
                break
            case 'readVectors':
                result = await database.readVectors(
                    command.presetId,
                    command.memoryIds
                )
                break
            case 'applyMutation':
                result = await database.applyMutation(command)
                break
            case 'clearPreset':
                result = await database.clearPreset(command.presetId)
                break
            case 'readInventoryPage':
                result = await database.readInventoryPage(
                    command.presetId,
                    command.afterMemoryId,
                    command.limit
                )
                break
            case 'markPresetState':
                result = await database.markPresetState(command)
                break
            case 'createRebuildFile':
                result = await database.createRebuildFile(
                    command.databaseDirectory,
                    command.manifest
                )
                break
            case 'appendRebuildBatch':
                result = await database.appendRebuildBatch(
                    command.presetId,
                    command.upserts
                )
                break
            case 'finalizeRebuild':
                result = await database.finalizeRebuild(
                    command.previousDatabaseDirectory,
                    command.expectedCount
                )
                break
            case 'abortRebuild':
                result = await database.abortRebuild()
                break
            case 'dispose':
                await database.dispose()
                result = { disposed: true }
                break
            default:
                throw new Error(
                    `unknown vector index worker command: ` +
                        `${(command as { type: string }).type}`
                )
        }
        return {
            id,
            type: command.type,
            ok: true,
            result
        } as VectorIndexWorkerResponse
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
    return [
        ...new Set(response.result.vectors.map(({ vector }) => vector.buffer))
    ]
}

export const startVectorIndexWorker = (
    port: VectorIndexWorkerPort,
    database: LivingMemoryVectorIndexDatabase
) => {
    let queue = Promise.resolve()
    port.on('message', (request) => {
        queue = queue
            .then(async () => {
                const response = await execute(database, request)
                try {
                    port.postMessage(response, responseTransferList(response))
                } finally {
                    if (request.command.type === 'dispose') {
                        port.close()
                    }
                }
            })
            .catch((error) => {
                setImmediate(() => {
                    throw error
                })
            })
    })
    return {
        waitForIdle: () => queue
    }
}
