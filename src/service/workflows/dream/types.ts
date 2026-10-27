import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'

export interface DreamBatch {
    id: string
    seedMemoryId?: string
    entries: DreamMemoryEntryRecord[]
}

export type DreamRunInput =
    | { mode: 'full' }
    | { mode: 'incremental'; memoryIds: string[] }

export interface DreamOperationStats {
    kept: number
    merged: number
    split: number
    updated: number
    archived: number
}

export interface DreamRunResult extends DreamOperationStats {
    untouchedSeedIds: string[]
    skipped: number
    entryCount: number
    batchCount: number
    status: 'completed' | 'partial' | 'failed'
    processedCount: number
    unprocessedMemoryIds: string[]
    skippedBatches: { batchId: string; memoryIds: string[]; reason: string }[]
    error?: string
    detail: string
}
