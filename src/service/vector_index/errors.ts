import type { MemoryVectorIndexState } from '../../contracts/vector_index'

export type LivingMemoryVectorIndexErrorCode =
    | 'embedding-unavailable'
    | 'lock-conflict'
    | 'not-ready'
    | 'rebuild-failed'
    | 'reconcile-failed'
    | 'worker-unavailable'

export class LivingMemoryVectorIndexError extends Error {
    constructor(
        public readonly code: LivingMemoryVectorIndexErrorCode,
        public readonly state: MemoryVectorIndexState,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options)
        this.name = 'LivingMemoryVectorIndexError'
    }
}
