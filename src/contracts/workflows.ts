import type {
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    LivingMemoryTranscriptMessage,
    MemoryEntryRecord,
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
import type { MemoryVectorIndexStatus } from './vector_index'

export interface DreamTriggerResult {
    success: true
    started: boolean
    reason?: 'preset-locked'
    runningJobId?: string
}

export interface DreamMemoryEntryRecord {
    id: string
    presetId: string
    speakerKeys: string[]
    type: MemoryEntryType
    content: string
    keywords: string[]
    summary: string | null
    sentiment: string | null
    importance: number | null
    createdAt: Date
    updatedAt: Date
}

export interface DreamMemoryMutation {
    speakerKeys: string[]
    type: MemoryEntryType
    content: string
    keywords: string[]
    summary: string
    sentiment: string
    importance: number
}

export interface DreamMergeMemoryVersion {
    id: string
    updatedAt: Date
}

export interface DreamMergeInput {
    presetId: string
    target: DreamMergeMemoryVersion
    sources: DreamMergeMemoryVersion[]
    patch: DreamMemoryMutation
    targetIsConsolidated: boolean
}

export interface MemoryUpdateResult {
    record: MemoryEntryRecord
    contentChanged: boolean
}

export interface DreamMergeResult {
    target: MemoryEntryRecord
    archivedSources: MemoryEntryRecord[]
    targetContentChanged: boolean
}

export interface DreamMergeRepository {
    applyDreamMerge(input: DreamMergeInput): Promise<DreamMergeResult>
}

export interface DreamMemoryRepository extends DreamMergeRepository {
    updateMemoryForDream(
        presetId: string,
        id: string,
        patch: DreamMemoryMutation | { status: 'archived' },
        isConsolidated?: boolean
    ): Promise<MemoryUpdateResult>
    setMemoryConsolidation(
        presetId: string,
        ids: string[],
        isConsolidated: boolean
    ): Promise<MemoryEntryRecord[]>
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

export interface MemoryServiceStatus {
    warnings: MemoryConfigWarning[]
    vectorIndex: MemoryVectorIndexStatus
}

export interface ExtractedMemoryItem {
    type: MemoryEntryType
    content: string
    keywords: string[]
    summary: string
    sentiment: string
    importance: number
    speakerLabels: string[]
}

export interface AttributedMemoryItem extends Omit<
    ExtractedMemoryItem,
    'speakerLabels'
> {
    speakerKeys: string[]
}

export interface RetrievedMemoryItem {
    id: string
    content: string
    score: number
}

export interface ExtractionPayload {
    input: string
    sourceOriginMessages: MemorySourceMessage[]
    speakers: Array<{
        speakerLabel: string
        speakerKey: string
    }>
}

export interface LivingMemoryConfig {
    enableSnapshotInjection: boolean
    enableUserProfileInjection: boolean
    recallStrategy: MemoryRecallStrategy
    mainModel: string
    subModel: string
    enableAutoDream: boolean
    autoDreamMemoryGrowthThreshold: number
    userProfileMinMemoryCount: number
    userProfileMemoryLimit: number
    enableRecallQueryRewrite: boolean
    recallInterval: number
    recallHistoryWindowRounds: number
    embeddingModel: string
    rerankModel: string
    extractionRounds: number
    extractionInterval: number
    recallTopK: number
    memorySearchToolMaxResults: number
    memorySearchMinSimilarity: number
    enableMemoryCreationTool: boolean
    memoryCreateToolMaxMemories: number
    debug: boolean
}

export interface RecallRepository {
    getRecallEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<LivingMemorySearchResult[]>
}

export interface LivingMemorySearchProvider {
    searchMemories(
        presetId: string,
        input: LivingMemorySearchInput
    ): Promise<LivingMemorySearchResult[]>
}

export interface LivingMemoryCreationProvider {
    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]>
    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys: string[]
    ): Promise<MemoryEntryRecord>
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
    createFailedJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        error: unknown,
        startedAt: Date,
        recallStrategy?: MemoryRecallStrategy | null
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
        sourceOriginMessages: MemorySourceMessage[],
        extracted: AttributedMemoryItem[]
    ): Promise<MemoryEntryRecord[]>
    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput
    ): Promise<MemoryEntryRecord>
    updateMemory(
        id: string,
        patch: Partial<MemoryMutationInput>
    ): Promise<MemoryUpdateResult | null>
    deleteMemory(id: string): Promise<MemoryEntryRecord | null>
}

/** 按消费方命名：画像生成需要的记忆查询，实现在记忆仓储。 */
export interface UserProfileMemoryRepository {
    getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]>
    listActiveMemorySpeakerLinks(
        presetId: string,
        speakerKeys: string[]
    ): Promise<Array<{ speakerKey: string; memoryId: string }>>
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
