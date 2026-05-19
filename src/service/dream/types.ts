import type { MemoryEntryRecord } from '../../types'

export interface CandidateGroup {
    reason: string
    entries: MemoryEntryRecord[]
}

export interface DreamCluster {
    id: string
    reason: string
    entries: MemoryEntryRecord[]
}

export interface DreamOperationStats {
    kept: number
    merged: number
    updated: number
    archived: number
    deleted: number
    skipped: number
}

export interface DreamRunResult extends DreamOperationStats {
    entryCount: number
    clusterCount: number
    skippedReason?: string
    detail: string
}

export type DreamStage = 'active' | 'archived'

export type DreamAction =
    | 'keep'
    | 'merge'
    | 'update'
    | 'archive'
    | 'deleteSource'

export interface DreamStageResult extends DreamOperationStats {
    stage: DreamStage
    entryCount: number
    clusterCount: number
    detail: string
}

export interface DreamOperation {
    action: DreamAction
    memoryId?: string
    memoryIds?: string[]
    targetMemoryId?: string
    sourceMemoryIds?: string[]
    memory?: Record<string, unknown>
    reason?: string
}
