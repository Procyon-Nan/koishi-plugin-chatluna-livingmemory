export const memoryEntryTypes = [
    'identity',
    'preference',
    'fact',
    'plan',
    'context',
    'other'
] as const

export const memoryRecallStrategies = [
    'embedding-rerank',
    'agentic-recall'
] as const

export const memoryJobKinds = ['recall', 'extract', 'dream', 'index'] as const

export const memoryJobStatuses = [
    'pending',
    'running',
    'completed',
    'failed'
] as const

export const memoryEntryStatuses = ['active', 'archived'] as const

export type MemoryEntryType = (typeof memoryEntryTypes)[number]
export type MemoryEntryStatus = (typeof memoryEntryStatuses)[number]
export type MemoryRecallStrategy = (typeof memoryRecallStrategies)[number]
export type MemoryJobKind = (typeof memoryJobKinds)[number]
export type MemoryJobStatus = (typeof memoryJobStatuses)[number]

export const livingMemorySearchMemoryTypes = [
    ...memoryEntryTypes,
    'all'
] as const

export type LivingMemorySearchMemoryType =
    (typeof livingMemorySearchMemoryTypes)[number]

export interface LivingMemorySearchInput {
    searchTexts: string[]
    searchKeywords?: string[]
    memoryTypes: LivingMemorySearchMemoryType[]
}

export interface LivingMemorySearchResult extends Pick<
    MemoryEntryRecord,
    | 'id'
    | 'type'
    | 'content'
    | 'keywords'
    | 'summary'
    | 'importance'
    | 'createdAt'
    | 'updatedAt'
> {}

export interface LivingMemorySearchDetailedResult extends LivingMemorySearchResult {
    cosineScore: number
    keywordMatchCount: number
    boostedScore: number
}

export interface MemoryReference {
    memoryId: string
    score?: number | null
}

export interface MemorySnapshotResolvedReference extends MemoryReference {
    memory: MemoryEntryRecord | null
    missing: boolean
}

export interface AgenticMemorySearchToolCallSummary {
    searchTexts: string[]
    searchKeywords: string[]
    maxCandidates: number
}

export interface AgenticMemorySnapshotMemoryItem extends Pick<
    LivingMemorySearchResult,
    | 'type'
    | 'content'
    | 'keywords'
    | 'summary'
    | 'importance'
    | 'createdAt'
    | 'updatedAt'
> {}

export interface AgenticMemorySnapshotItem {
    finalText: string
    toolCallSummary: AgenticMemorySearchToolCallSummary
    matchedMemories: AgenticMemorySnapshotMemoryItem[]
}

export type MemorySnapshotItem = MemoryReference | AgenticMemorySnapshotItem

export interface MemoryScope {
    conversationId: string
    presetId: string
    presetLabel?: string
    userId?: string
    channelId?: string
    guildId?: string
    isDirect?: boolean
    speakerId?: string
    platform?: string
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

export interface LivingMemoryGetMessagesSourceOrigin {
    originIndex: number
    messages: MemorySourceMessage[]
}

export interface LivingMemoryGetMessagesMemory extends Pick<
    MemoryEntryRecord,
    'id' | 'type' | 'content' | 'keywords' | 'summary' | 'importance'
> {
    createdAt: string
    updatedAt: string
    sourceOrigins: LivingMemoryGetMessagesSourceOrigin[]
}

export interface LivingMemoryGetMessagesOutput {
    memories: LivingMemoryGetMessagesMemory[]
    notFoundMemoryIds: string[]
}

export interface LivingMemoryTranscriptMessage {
    role: 'user' | 'assistant'
    speakerKey?: string
    speakerLabel: string
    contentLines: string[]
    createdAt: Date
}

export interface LivingMemoryCompletedRound {
    messages: LivingMemoryTranscriptMessage[]
}

export interface MemoryEntryRecord {
    id: string
    presetId: string
    speakerKeys: string[]
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

export interface LivingMemoryMigrationRecord {
    id: string
    appliedAt: Date
}

export interface MemorySnapshotRecord {
    id: string
    presetId: string
    conversationId: string
    strategy: MemoryRecallStrategy
    query: string
    items: MemorySnapshotItem[]
    createdAt: Date
}

export interface MemorySnapshotResolvedItem extends MemoryReference {
    memory: MemoryEntryRecord | null
    missing: boolean
}

export interface MemorySnapshotWithResolvedItems extends MemorySnapshotRecord {
    resolvedItems: MemorySnapshotResolvedItem[]
}

export interface MemoryJobRecord {
    id: string
    presetId: string
    conversationId: string
    kind: MemoryJobKind
    recallStrategy: MemoryRecallStrategy | null
    status: MemoryJobStatus
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

export interface UserProfileInput {
    speakerKey: string
    speakerLabel: string
    content: string
    sourceMemoryIds: string[]
}

export interface PresetSpeakerRecord {
    id: string
    presetId: string
    speakerKey: string
    speakerLabel: string
    speakerAliases: string[]
    speakerId: string | null
    platform: string | null
    createdAt: Date
    updatedAt: Date
}

export interface PresetSpeakerInput {
    presetId: string
    speakerKey: string
    speakerLabel: string
    speakerId?: string | null
    platform?: string | null
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

export interface LivingMemoryPresetExportEntryV3 extends LivingMemoryPresetExportEntryV2 {
    speakerKeys: string[]
}

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

interface LivingMemoryPresetExportBase {
    exportedAt: string
    sourcePresetId: string
    userProfiles: LivingMemoryPresetExportUserProfile[]
    presetSpeakers: LivingMemoryPresetExportSpeaker[]
}

export interface LivingMemoryPresetExportV1 extends LivingMemoryPresetExportBase {
    version: 1
    entries: LivingMemoryPresetExportEntry[]
}

export interface LivingMemoryPresetExportV2 extends LivingMemoryPresetExportBase {
    version: 2
    entries: LivingMemoryPresetExportEntryV2[]
}

export interface LivingMemoryPresetExportV3 extends LivingMemoryPresetExportBase {
    version: 3
    entries: LivingMemoryPresetExportEntryV3[]
}

export type LivingMemoryPresetExport =
    | LivingMemoryPresetExportV1
    | LivingMemoryPresetExportV2
    | LivingMemoryPresetExportV3

export interface LivingMemoryPresetImportSummary {
    entries: number
    userProfiles: number
    presetSpeakers: number
}

export interface LivingMemoryPresetImportResult extends LivingMemoryPresetImportSummary {
    indexJobId: string
}
