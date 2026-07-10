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

export const memoryJobKinds = ['recall', 'extract', 'dream'] as const

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
    broadSearchTexts: string[]
    specificSearchTexts?: string[]
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
> {
    matchedBroadSearchTexts: string[]
    matchedSpecificSearchTexts: string[]
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
    broadSearchTexts: string[]
    specificSearchTexts?: string[]
    memoryTypes: LivingMemorySearchMemoryType[]
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
    | 'matchedBroadSearchTexts'
    | 'matchedSpecificSearchTexts'
> {}

export interface AgenticMemorySnapshotItem {
    finalText: string
    toolCallSummary: AgenticMemorySearchToolCallSummary
    matchedBroadSearchTexts: string[]
    matchedSpecificSearchTexts: string[]
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
    speakerName?: string
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
    speakerLabel: string
    contentLines: string[]
    createdAt: Date
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
    embedding: number[] | null
    embeddingModelId: string | null
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
    speakerId: string | null
    createdAt: Date
    updatedAt: Date
}

export interface PresetSpeakerInput {
    presetId: string
    speakerKey: string
    speakerLabel: string
    speakerId?: string | null
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
