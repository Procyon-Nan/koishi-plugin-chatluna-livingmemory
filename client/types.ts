// 客户端本地类型声明，与服务端 src/types.ts 保持同步
// 不从 ../src/types 导入，因为服务端文件含有 koishi-plugin-chatluna 等副作用导入，
// koishi-console build (Vite) 无法解析

export const memoryEntryTypes = [
    'identity',
    'preference',
    'fact',
    'plan',
    'context',
    'other'
] as const

export type MemoryEntryType = (typeof memoryEntryTypes)[number]

export type MemoryEntryStatus = 'active' | 'archived'
export type MemoryRecallStrategy = 'embedding-rerank' | 'agentic-recall'

export type LivingMemorySearchMemoryType = MemoryEntryType | 'all'

export interface LivingMemorySearchInput {
    searchTexts: string[]
    searchKeywords?: string[]
    memoryTypes: LivingMemorySearchMemoryType[]
}

export interface LivingMemorySearchDetailedResult {
    id: string
    type: MemoryEntryType
    content: string
    keywords: string[]
    summary: string | null
    importance: number | null
    createdAt: Date
    updatedAt: Date
    cosineScore: number
    keywordMatchCount: number
    boostedScore: number
}

export interface MemorySourceMessage {
    role: 'user' | 'assistant' | 'system'
    speakerLabel?: string
    contentLines?: string[]
    createdAt?: string
    transcriptLines?: string[]
    content: string
}

export interface MemorySourceOrigin {
    messages: MemorySourceMessage[]
}

export interface MemoryEntryRecord {
    id: string
    presetId: string
    type: MemoryEntryType
    status: MemoryEntryStatus
    content: string
    keywords: string[]
    summary: string | null
    sentiment: string | null
    importance: number | null
    sourceConversationId: string | null
    sourceOrigins: MemorySourceOrigin[]
    isConsolidated: boolean
    createdAt: Date
    updatedAt: Date
}

export interface MemorySnapshotRecord {
    id: string
    presetId: string
    conversationId: string
    strategy: MemoryRecallStrategy
    query: string
    items: MemorySnapshotItem[]
    resolvedItems: MemorySnapshotResolvedItem[]
    createdAt: Date
}

export interface MemoryReference {
    memoryId: string
    score?: number | null
}

export interface MemorySnapshotResolvedItem extends MemoryReference {
    memory: MemoryEntryRecord | null
    missing: boolean
}

export interface AgenticMemorySearchToolCallSummary {
    searchTexts: string[]
    searchKeywords: string[]
    memoryTypes: LivingMemorySearchMemoryType[]
    maxCandidates: number
}

export interface AgenticMemorySnapshotMemoryItem {
    type: MemoryEntryType
    content: string
    keywords: string[]
    summary: string | null
    importance: number | null
    createdAt: Date
    updatedAt: Date
    matchedSearchTexts: string[]
}

export interface AgenticMemorySnapshotItem {
    finalText: string
    toolCallSummary: AgenticMemorySearchToolCallSummary
    matchedSearchTexts: string[]
    matchedMemories: AgenticMemorySnapshotMemoryItem[]
}

export type MemorySnapshotItem = MemoryReference | AgenticMemorySnapshotItem

export interface MemoryJobRecord {
    id: string
    presetId: string
    conversationId: string
    kind: string
    recallStrategy: MemoryRecallStrategy | null
    status: string
    input: string
    detail: string | null
    error: string | null
    createdAt: Date
    startedAt: Date | null
    finishedAt: Date | null
    updatedAt: Date
}

export interface UserProfileRecord {
    id: string
    presetId: string
    speakerKey: string
    speakerLabel: string
    content: string
    sourceMemoryIds: string[]
    createdAt: Date
    updatedAt: Date
}

export interface DreamTriggerResult {
    success: true
    started: boolean
    reason?: 'preset-locked'
    runningJobId?: string
}

export type MemoryConfigWarningCode =
    | 'embedding-model-missing'
    | 'extract-model-missing'
    | 'recall-rewrite-model-missing'
    | 'agentic-recall-model-missing'
    | 'auto-dream-model-missing'
    | 'auto-dream-embedding-model-missing'

export interface MemoryConfigWarning {
    code: MemoryConfigWarningCode
    field: string
    message: string
}

export type MemoryVectorIndexState =
    | 'ready'
    | 'building'
    | 'dirty'
    | 'unavailable'

export interface MemoryVectorIndexManifest {
    schemaVersion: number
    embeddingModelId: string
    dimension: number
    storageEngine: 'pglite-pgvector'
    vectorExtensionVersion: string
    generation: string
    builtAt: number
}

export interface MemoryVectorIndexPresetStatus {
    presetId: string
    state: MemoryVectorIndexState
    expectedCount: number
    indexedCount: number
    lastError: string | null
    updatedAt: number
}

export interface MemoryVectorIndexStatus {
    state: MemoryVectorIndexState
    manifest: MemoryVectorIndexManifest | null
    presets: MemoryVectorIndexPresetStatus[]
    currentJobId: string | null
    lastError: string | null
}

export interface MemoryServiceStatus {
    warnings: MemoryConfigWarning[]
    vectorIndex: MemoryVectorIndexStatus
}

export interface MemoryMutationInput {
    type: MemoryEntryType
    status?: MemoryEntryStatus
    content: string
    keywords?: string[]
    summary?: string | null
    sentiment?: string | null
    importance?: number | null
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

export interface MemoryListFilter {
    presetId: string
    type?: MemoryEntryType
    status?: MemoryEntryStatus | 'all'
    keyword?: string
}

export interface MemoryListResult extends PageResult<MemoryEntryRecord> {
    facets: MemoryListFacets
}

interface LivingMemoryPresetExportBase {
    exportedAt: string
    sourcePresetId: string
    userProfiles: LivingMemoryPresetExportUserProfile[]
    presetSpeakers: LivingMemoryPresetExportSpeaker[]
}

export interface LivingMemoryPresetExportEntry {
    id: string
    type: MemoryEntryType
    status: MemoryEntryStatus
    content: string
    keywords: string[]
    summary: string | null
    sentiment: string | null
    importance: number | null
    sourceConversationId: string | null
    sourceOrigins: MemorySourceOrigin[]
    createdAt: string
    updatedAt: string
}

export interface LivingMemoryPresetExportEntryV2 extends LivingMemoryPresetExportEntry {
    isConsolidated: boolean
}

export interface LivingMemoryPresetExportV1 extends LivingMemoryPresetExportBase {
    version: 1
    entries: LivingMemoryPresetExportEntry[]
}

export interface LivingMemoryPresetExportV2 extends LivingMemoryPresetExportBase {
    version: 2
    entries: LivingMemoryPresetExportEntryV2[]
}

export type LivingMemoryPresetExport =
    | LivingMemoryPresetExportV1
    | LivingMemoryPresetExportV2

export interface LivingMemoryPresetExportUserProfile {
    id: string
    speakerKey: string
    speakerLabel: string
    content: string
    sourceMemoryIds: string[]
    createdAt: string
    updatedAt: string
}

export interface LivingMemoryPresetExportSpeaker {
    speakerKey: string
    speakerLabel: string
    speakerAliases?: string[]
    speakerId: string | null
    platform?: string | null
    createdAt: string
    updatedAt: string
}

export interface LivingMemoryPresetImportResult {
    entries: number
    userProfiles: number
    presetSpeakers: number
    indexJobId: string
}

export interface LivingMemoryClientEvents {
    'living-memory/listPresetIds': () => string[]
    'living-memory/getStatus': () => MemoryServiceStatus
    'living-memory/listMemories': (query: {
        presetId: string
        type?: MemoryEntryType
        status?: MemoryEntryStatus | 'all'
        keyword?: string
        page?: number
        pageSize?: number
    }) => MemoryListResult
    'living-memory/listMemoryIds': (filter: MemoryListFilter) => string[]
    'living-memory/getMemory': (
        memoryId: string
    ) => MemoryEntryRecord | undefined
    'living-memory/createMemory': (input: {
        conversationId: string
        presetId: string
        userId?: string
        channelId?: string
        memory: MemoryMutationInput
    }) => MemoryEntryRecord
    'living-memory/updateMemory': (
        memoryId: string,
        patch: Partial<MemoryMutationInput>
    ) => { success: true }
    'living-memory/deleteMemory': (memoryId: string) => { success: true }
    'living-memory/deleteMemories': (
        presetId: string,
        ids: string[]
    ) => { success: true; deleted: number }
    'living-memory/listSnapshots': (query: {
        presetId: string
        conversationId?: string
        page?: number
        pageSize?: number
    }) => PageResult<MemorySnapshotRecord>
    'living-memory/deleteSnapshot': (snapshotId: string) => {
        success: true
    }
    'living-memory/listJobs': (query: {
        presetId: string
        kind?: string
        status?: string
        page?: number
        pageSize?: number
    }) => PageResult<MemoryJobRecord>
    'living-memory/listUserProfiles': (query: {
        presetId: string
        page?: number
        pageSize?: number
    }) => PageResult<UserProfileRecord>
    'living-memory/updateUserProfile': (
        profileId: string,
        content: string
    ) => { success: true }
    'living-memory/deleteUserProfile': (profileId: string) => {
        success: true
    }
    'living-memory/runDream': (presetId: string) => DreamTriggerResult
    'living-memory/reconcileVectorIndex': (presetId: string) => MemoryJobRecord
    'living-memory/rebuildVectorIndex': () => { success: true }
    'living-memory/restartVectorIndex': () => { success: true }
    'living-memory/clearPresetData': (presetId: string) => { success: true }
    'living-memory/exportPreset': (presetId: string) => LivingMemoryPresetExport
    'living-memory/importPreset': (
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ) => LivingMemoryPresetImportResult
    'living-memory/searchMemoriesDetailed': (
        presetId: string,
        input: LivingMemorySearchInput
    ) => LivingMemorySearchDetailedResult[]
}
