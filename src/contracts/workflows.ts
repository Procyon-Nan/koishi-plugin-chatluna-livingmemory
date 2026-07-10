import type {
    LivingMemoryTranscriptMessage,
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobKind,
    MemoryJobRecord,
    MemoryMutationInput,
    MemoryRecallStrategy,
    MemoryScope,
    MemorySnapshotItem,
    MemorySnapshotRecord,
    MemorySourceMessage,
    PresetSpeakerInput,
    PresetSpeakerRecord,
    UserProfileInput,
    UserProfileRecord
} from './memory'

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
    | 'agentic-recall-model-missing'
    | 'auto-dream-model-missing'

export interface MemoryConfigWarning {
    code: MemoryConfigWarningCode
    field: string
    message: string
}

export interface MemoryServiceStatus {
    warnings: MemoryConfigWarning[]
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
    sourceOriginMessages: MemorySourceMessage[]
}

export interface LivingMemoryConfig {
    enableSnapshotInjection: boolean
    enableUserProfileInjection: boolean
    recallStrategy: MemoryRecallStrategy
    extractModel: string
    dreamModel: string
    enableAutoDream: boolean
    autoDreamMemoryGrowthThreshold: number
    userProfileMemoryLimit: number
    enableRecallQueryRewrite: boolean
    recallHistoryWindowRounds: number
    recallRewriteModel: string
    agenticRecallModel: string
    embeddingModel: string
    rerankModel: string
    extractionRounds: number
    extractionInterval: number
    recallTopK: number
    memorySearchToolMaxResults: number
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
        items: MemorySnapshotItem[]
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
        input: string,
        recallStrategy?: MemoryRecallStrategy | null
    ): Promise<MemoryJobRecord>
    updateJob(id: string, patch: Partial<MemoryJobRecord>): Promise<void>
    listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]>
    getLatestJobByPresetAndKind(
        presetId: string,
        kind: MemoryJobKind
    ): Promise<MemoryJobRecord | undefined>
    markStaleRunningJobsAsFailed(
        options?: { presetId?: string; kind?: MemoryJobKind },
        reason?: string
    ): Promise<MemoryJobRecord[]>
}

export interface ExtractionRepository {
    appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: ExtractedMemoryItem[]
    ): Promise<void>
    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput
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
