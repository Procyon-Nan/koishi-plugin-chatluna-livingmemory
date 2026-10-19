import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'

export interface DreamCluster {
    id: string
    entries: DreamMemoryEntryRecord[]
}

export interface DreamOperationStats {
    kept: number
    merged: number
    updated: number
    archived: number
    skipped: number
}

export interface DreamRunResult extends DreamOperationStats {
    entryCount: number
    clusterCount: number
    status: 'completed' | 'partial' | 'failed'
    processedCount: number
    unprocessedMemoryIds: string[]
    skippedBatches: { batchId: string; memoryIds: string[]; reason: string }[]
    error?: string
    detail: string
}
