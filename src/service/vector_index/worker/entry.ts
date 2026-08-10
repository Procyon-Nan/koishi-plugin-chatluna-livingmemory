import { parentPort } from 'node:worker_threads'
import type { VectorIndexWorkerError, VectorIndexWorkerRequest, VectorIndexWorkerResponse } from '../worker_protocol'
import { LivingMemoryVectorIndexDatabase } from './database'

const port = parentPort
if (port === null) throw new Error('vector index worker requires a parent port')
const database = new LivingMemoryVectorIndexDatabase()
const serializeError = (error: unknown): VectorIndexWorkerError => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null } : { name: 'Error', message: String(error), stack: null }

const execute = async (request: VectorIndexWorkerRequest): Promise<VectorIndexWorkerResponse> => {
    const { id, command } = request
    try {
        let result: unknown
        switch (command.type) {
            case 'open': result = await database.open(command.databaseDirectory, command.previousDatabaseDirectory); break
            case 'inspect': result = await database.inspect(); break
            case 'queryKnn': result = await database.queryKnn(command); break
            case 'queryHybrid': result = await database.queryHybrid(command); break
            case 'readVectors': result = await database.readVectors(command.presetId, command.memoryIds); break
            case 'applyMutation': result = await database.applyMutation(command); break
            case 'clearPreset': result = await database.clearPreset(command.presetId); break
            case 'readInventoryPage': result = await database.readInventoryPage(command.presetId, command.afterMemoryId, command.limit); break
            case 'markPresetState': result = await database.markPresetState(command); break
            case 'createRebuildFile': result = await database.createRebuildFile(command.databaseDirectory, command.manifest); break
            case 'appendRebuildBatch': result = await database.appendRebuildBatch(command.presetId, command.upserts); break
            case 'finalizeRebuild': result = await database.finalizeRebuild(command.previousDatabaseDirectory, command.expectedCount); break
            case 'abortRebuild': result = await database.abortRebuild(); break
            case 'dispose': await database.dispose(); result = { disposed: true }; break
        }
        return { id, type: command.type, ok: true, result } as VectorIndexWorkerResponse
    } catch (error) {
        return { id, type: command.type, ok: false, error: serializeError(error) } as VectorIndexWorkerResponse
    }
}
const responseTransferList = (response: VectorIndexWorkerResponse) => {
    if (!response.ok || response.type !== 'readVectors') return []
    return [...new Set(response.result.vectors.map(({ vector }) => vector.buffer))]
}

let queue = Promise.resolve()
port.on('message', (request: VectorIndexWorkerRequest) => {
    queue = queue
        .then(async () => {
            const response = await execute(request)
            port.postMessage(response, responseTransferList(response))
            if (response.ok && response.type === 'dispose') port.close()
        })
        .catch((error) => {
            queue = Promise.resolve()
            setImmediate(() => {
                throw error
            })
        })
})
