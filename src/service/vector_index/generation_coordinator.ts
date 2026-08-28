import { LivingMemoryVectorIndexError } from './errors'

const GENERATIONS_KEY = Symbol.for(
    'chatluna-livingmemory.vector-index-generations'
)

interface VectorIndexGenerationRecord {
    stopping: boolean
    stopped: Promise<void>
    resolveStopped: () => void
}

const globalState = globalThis as unknown as Record<PropertyKey, unknown>
if (!(globalState[GENERATIONS_KEY] instanceof Map)) {
    globalState[GENERATIONS_KEY] = new Map<
        string,
        VectorIndexGenerationRecord
    >()
}
const generations = globalState[GENERATIONS_KEY] as Map<
    string,
    VectorIndexGenerationRecord
>

const createConflictError = (directoryIdentity: string) =>
    new LivingMemoryVectorIndexError(
        'lock-conflict',
        'unavailable',
        `vector index generation is already active in this process: ` +
            directoryIdentity
    )

export interface LivingMemoryVectorIndexGeneration {
    beginStop(): void
    release(): void
}

export const acquireVectorIndexGeneration = async (
    directoryIdentity: string
): Promise<LivingMemoryVectorIndexGeneration> => {
    while (true) {
        const current = generations.get(directoryIdentity)
        if (current === undefined) {
            let resolveStopped!: () => void
            const stopped = new Promise<void>((resolve) => {
                resolveStopped = resolve
            })
            const record: VectorIndexGenerationRecord = {
                stopping: false,
                stopped,
                resolveStopped
            }
            generations.set(directoryIdentity, record)
            return {
                beginStop() {
                    record.stopping = true
                },
                release() {
                    generations.delete(directoryIdentity)
                    record.resolveStopped()
                }
            }
        }
        if (!current.stopping) {
            throw createConflictError(directoryIdentity)
        }
        await current.stopped
    }
}
