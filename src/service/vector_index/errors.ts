import type { MemoryVectorIndexState } from '../../contracts/vector_index'

export type LivingMemoryVectorIndexErrorCode =
    | 'embedding-unavailable'
    | 'lock-conflict'
    | 'lock-unavailable'
    | 'mutation-failed'
    | 'not-ready'
    | 'rebuild-failed'
    | 'reconcile-failed'
    | 'vector-missing'
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

export class LivingMemoryFactsCommittedError extends Error {
    readonly factsCommitted = true

    constructor(message: string, options: ErrorOptions) {
        super(message, options)
        this.name = 'LivingMemoryFactsCommittedError'
    }
}
