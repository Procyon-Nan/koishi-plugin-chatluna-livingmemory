import type {
    JobListQuery,
    MemoryListQuery,
    PageResult,
    SnapshotListQuery,
    UserProfileListQuery
} from './query'
import {} from 'koishi-plugin-chatluna/services/chat'
import type { ChatLunaLivingMemoryService } from './service/memory'

export const memoryEntryTypes = [
    'identity',
    'preference',
    'fact',
    'plan',
    'context',
    'other'
] as const

export const memoryRecallStrategies = ['keyword', 'embedding-rerank'] as const

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

export interface MemoryReference {
    memoryId: string
    score?: number | null
}

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
    sourceMessages: MemorySourceMessage[]
    embedding: number[] | null
    embeddingModelId: string | null
    createdAt: Date
    updatedAt: Date
}

export interface MemorySnapshotRecord {
    id: string
    presetId: string
    conversationId: string
    strategy: MemoryRecallStrategy
    query: string
    items: MemoryReference[]
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

export interface DreamTriggerResult {
    success: true
    started: boolean
    reason?: 'preset-locked'
    runningJobId?: string
}

export type MemoryConfigWarningCode =
    | 'embedding-model-missing'
    | 'rerank-model-missing'
    | 'extract-model-missing'
    | 'recall-rewrite-model-missing'

export interface MemoryConfigWarning {
    code: MemoryConfigWarningCode
    field: string
    message: string
}

export interface MemoryServiceStatus {
    warnings: MemoryConfigWarning[]
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

export interface ExtractedMemoryItem {
    type: MemoryEntryType
    status?: MemoryEntryStatus
    content: string
    keywords?: string[]
    summary?: string | null
    sentiment?: string | null
    importance?: number | null
}

export interface RetrievedMemoryItem {
    id: string
    content: string
    score: number
}

export interface ExtractionPayload {
    input: string
    sourceMessages: MemorySourceMessage[]
}

export interface LivingMemoryConfig {
    enableSnapshotInjection: boolean
    enableUserProfileInjection: boolean
    extractModel: string
    dreamModel: string
    userProfileMemoryLimit: number
    enableRecallQueryRewrite: boolean
    recallRewriteRounds: number
    recallRewriteModel: string
    embeddingModel: string
    rerankModel: string
    extractionRounds: number
    extractionInterval: number
    recallTopK: number
    recallStrategy: MemoryRecallStrategy
    enableKeywordFallback: boolean
    debug: boolean
}

export interface RecallRepository {
    listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]>
    getEntryById(id: string): Promise<MemoryEntryRecord | undefined>
    updateEntryEmbeddings(
        updates: {
            id: string
            embedding: number[]
            embeddingModelId: string
        }[]
    ): Promise<void>
}

export interface SnapshotRepository {
    getLatestSnapshotByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ): Promise<MemorySnapshotRecord | undefined>
    listSnapshotsByPreset(presetId: string): Promise<MemorySnapshotRecord[]>
    upsertSnapshot(
        scope: MemoryScope,
        strategy: MemoryRecallStrategy,
        query: string,
        items: MemoryReference[]
    ): Promise<void>
    deleteSnapshot(
        snapshotId: string
    ): Promise<MemorySnapshotRecord | undefined>
    deleteSnapshotsByConversation(
        conversationId: string
    ): Promise<MemorySnapshotRecord[]>
}

export interface JobRepository {
    createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string
    ): Promise<MemoryJobRecord>
    updateJob(id: string, patch: Partial<MemoryJobRecord>): Promise<void>
    listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]>
    markStaleRunningJobsAsFailed(
        options?: { presetId?: string; kind?: MemoryJobKind },
        reason?: string
    ): Promise<MemoryJobRecord[]>
}

export interface ExtractionRepository {
    appendMemories(
        scope: MemoryScope,
        sourceMessages: MemorySourceMessage[],
        extracted: ExtractedMemoryItem[]
    ): Promise<void>
    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        sourceMessages?: MemorySourceMessage[]
    ): Promise<MemoryEntryRecord>
    updateMemory(id: string, patch: Partial<MemoryMutationInput>): Promise<void>
    deleteMemory(id: string): Promise<void>
}

export interface UserProfileRepository {
    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]>
    upsertPresetSpeaker(input: PresetSpeakerInput): Promise<void>
    listUserProfilesByPreset(presetId: string): Promise<UserProfileRecord[]>
    listUserProfilesBySpeakerKeys(
        presetId: string,
        speakerKeys: string[]
    ): Promise<UserProfileRecord[]>
    replaceUserProfile(
        presetId: string,
        profile: UserProfileInput
    ): Promise<void>
    deleteUserProfile(profileId: string): Promise<void>
}

export interface MessageFormatter {
    takeRecentRounds(
        messages: LivingMemoryTranscriptMessage[],
        roundCount: number
    ): LivingMemoryTranscriptMessage[]
    toExtractionPayload(
        messages: LivingMemoryTranscriptMessage[]
    ): ExtractionPayload
}

declare module 'koishi' {
    interface Context {
        chatluna_living_memory: ChatLunaLivingMemoryService
    }

    interface Tables {
        living_memory_entry: MemoryEntryRecord
        living_memory_snapshot: MemorySnapshotRecord
        living_memory_job: MemoryJobRecord
        living_memory_user_profile: UserProfileRecord
        living_memory_preset_speaker: PresetSpeakerRecord
    }
}

declare module '@koishijs/plugin-console' {
    interface Events {
        'living-memory/listPresetIds': () => Promise<string[]>
        'living-memory/getStatus': () => Promise<MemoryServiceStatus>
        'living-memory/listMemories': (
            query: MemoryListQuery
        ) => Promise<PageResult<MemoryEntryRecord>>
        'living-memory/getMemory': (
            memoryId: string
        ) => Promise<MemoryEntryRecord | undefined>
        'living-memory/createMemory': (input: {
            conversationId: string
            presetId: string
            userId?: string
            channelId?: string
            memory: MemoryMutationInput
        }) => Promise<MemoryEntryRecord>
        'living-memory/updateMemory': (
            memoryId: string,
            patch: Partial<MemoryMutationInput>
        ) => Promise<{ success: true }>
        'living-memory/deleteMemory': (
            memoryId: string
        ) => Promise<{ success: true }>
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
        'living-memory/deleteUserProfile': (
            profileId: string
        ) => Promise<{ success: true }>
        'living-memory/runDream': (
            presetId: string
        ) => Promise<DreamTriggerResult>
        'living-memory/clearPresetData': (
            presetId: string
        ) => Promise<{ success: true }>
    }
}
