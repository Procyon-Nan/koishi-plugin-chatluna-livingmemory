import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import type { DreamOperation as SchemaDreamOperation } from '../../prompts/schema'

export interface DreamCluster {
    id: string
    reason: string
    entries: DreamMemoryEntryRecord[]
}

export interface DreamOperationStats {
    kept: number
    merged: number
    updated: number
    archived: number
    deleted: number
    skipped: number
}

export type DreamConsolidationMode =
    | 'manual'
    | 'incremental-batch'
    | 'incremental-seed'

export interface DreamExecutionResult extends DreamOperationStats {
    consolidatedMemoryIds: Set<string>
    mutatedMemoryIds: Set<string>
}

export interface DreamRunResult extends DreamOperationStats {
    entryCount: number
    clusterCount: number
    stageResults?: DreamStageResult[]
    skippedReason?: string
    detail: string
}

export type DreamStage = 'active' | 'archived'

export interface DreamStageResult extends DreamOperationStats {
    stage: DreamStage
    entryCount: number
    clusterCount: number
    detail: string
}

export type DreamOperation = SchemaDreamOperation

export type DreamUnitResult =
    | (DreamExecutionResult & { success: true })
    | (DreamExecutionResult & { success: false; error: string })
