import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord,
    MemoryJobStatus,
    MemoryMutationInput,
    MemorySnapshotWithResolvedItems,
    PresetSpeakerRecord,
    UserProfileRecord
} from './memory'
import type { DreamTriggerResult, MemoryServiceStatus } from './workflows'

export interface PageRequest {
    page?: number
    pageSize?: number
}

export interface MemoryListFilter {
    presetId: string
    type?: MemoryEntryRecord['type']
    status?: MemoryEntryStatus | 'all'
    keyword?: string
    speakerKey?: string
}

export interface MemoryListQuery extends MemoryListFilter, PageRequest {}

export interface SnapshotListQuery extends PageRequest {
    presetId: string
    conversationId?: string
}

export interface JobListQuery extends PageRequest {
    presetId: string
    kind?: MemoryJobRecord['kind']
    status?: MemoryJobStatus
}

export interface UserProfileListQuery extends PageRequest {
    presetId: string
}

export interface PageResult<T> {
    items: T[]
    page: number
    pageSize: number
    total: number
}

export type MemoryFacetStatus = MemoryEntryStatus | 'all'

export interface MemoryListFacets {
    statuses: Record<MemoryFacetStatus, number>
    types: Record<MemoryFacetStatus, Record<MemoryEntryType, number>>
}

export interface MemoryListResult extends PageResult<MemoryEntryRecord> {
    facets: MemoryListFacets
}

export interface CreateMemoryRequest {
    conversationId: string
    presetId: string
    userId?: string
    channelId?: string
    memory: MemoryMutationInput
}

export interface LivingMemoryConsoleEvents {
    'living-memory/listPresetIds': () => Promise<string[]>
    'living-memory/getStatus': () => Promise<MemoryServiceStatus>
    'living-memory/listMemories': (
        query: MemoryListQuery
    ) => Promise<MemoryListResult>
    'living-memory/listMemoryIds': (
        filter: MemoryListFilter
    ) => Promise<string[]>
    'living-memory/getMemory': (
        memoryId: string
    ) => Promise<MemoryEntryRecord | undefined>
    'living-memory/createMemory': (
        input: CreateMemoryRequest
    ) => Promise<MemoryEntryRecord>
    'living-memory/updateMemory': (
        memoryId: string,
        patch: Partial<MemoryMutationInput>
    ) => Promise<{ success: true }>
    'living-memory/deleteMemory': (
        memoryId: string
    ) => Promise<{ success: true }>
    'living-memory/deleteMemories': (
        presetId: string,
        ids: string[]
    ) => Promise<{ success: true; deleted: number }>
    'living-memory/listSnapshots': (
        query: SnapshotListQuery
    ) => Promise<PageResult<MemorySnapshotWithResolvedItems>>
    'living-memory/deleteSnapshot': (
        snapshotId: string
    ) => Promise<{ success: true }>
    'living-memory/listJobs': (
        query: JobListQuery
    ) => Promise<PageResult<MemoryJobRecord>>
    'living-memory/listUserProfiles': (
        query: UserProfileListQuery
    ) => Promise<PageResult<UserProfileRecord>>
    'living-memory/listPresetSpeakers': (
        presetId: string
    ) => Promise<PresetSpeakerRecord[]>
    'living-memory/updateUserProfile': (
        profileId: string,
        content: string
    ) => Promise<{ success: true }>
    'living-memory/deleteUserProfile': (
        profileId: string
    ) => Promise<{ success: true }>
    'living-memory/runDream': (presetId: string) => Promise<DreamTriggerResult>
    'living-memory/reconcileVectorIndex': (
        presetId: string
    ) => Promise<MemoryJobRecord>
    'living-memory/rebuildVectorIndex': () => Promise<{ success: true }>
    'living-memory/restartVectorIndex': () => Promise<{ success: true }>
    'living-memory/clearPresetData': (
        presetId: string
    ) => Promise<{ success: true }>
    'living-memory/exportPreset': (
        presetId: string
    ) => Promise<LivingMemoryPresetExport>
    'living-memory/importPreset': (
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ) => Promise<LivingMemoryPresetImportResult>
    'living-memory/searchMemoriesDetailed': (
        presetId: string,
        input: LivingMemorySearchInput
    ) => Promise<LivingMemorySearchDetailedResult[]>
}
