import type {
    AgenticMemorySnapshotItem,
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    LivingMemoryGetMessagesMemory,
    MemoryEntryRecord,
    MemoryEntryType,
    MemoryJobKind,
    MemoryJobRecord,
    MemoryMutationInput,
    MemoryUpdatePatch,
    MemoryScope,
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
    reason?: 'preset-locked' | 'insufficient-memories'
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
    sourceLabel: string | null
    createdAt: Date
    updatedAt: Date
}

export type MemoryConfigWarningCode =
    | 'recall-model-missing'
    | 'embedding-model-missing'
    | 'extract-model-missing'

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

export interface ExtractionPayload {
    input: string
    sourceOriginMessages: MemorySourceMessage[]
    speakers: Array<{
        speakerLabel: string
        speakerKey: string
    }>
}

export interface LivingMemoryConfig {
    enableConversationIsolation: boolean
    enableSnapshotInjection: boolean
    enableUserProfileInjection: boolean
    mainModel: string
    subModel: string
    userProfileMinMemoryCount: number
    userProfileMemoryLimit: number
    recallIntervalMessages: number
    recallHistoryMessages: number
    embeddingModel: string
    rerankModel: string
    extractionWindowMessages: number
    extractionIncludeOverheard: boolean
    enableExtractionWhitelist: boolean
    extractionWhitelist: string[]
    memorySearchToolMaxResults: number
    memorySearchMinSimilarity: number
    enableMemoryTools: boolean
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
        input: LivingMemorySearchInput,
        conversationId?: string
    ): Promise<LivingMemorySearchResult[]>
}

export interface LivingMemorySourceProvider {
    getMemorySourceMessages(
        presetId: string,
        memoryId: string
    ): Promise<LivingMemoryGetMessagesMemory | null>
}

export interface LivingMemoryCreationProvider {
    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]>
    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys: string[]
    ): Promise<MemoryEntryRecord>
}

export interface LivingMemoryUpdateProvider {
    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]>
    updateActiveMemory(
        presetId: string,
        memoryId: string,
        patch: Omit<MemoryUpdatePatch, 'status'>
    ): Promise<MemoryEntryRecord | null>
}

export interface LivingMemoryMergeProvider {
    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]>
    mergeActiveMemories(
        presetId: string,
        sourceMemoryIds: string[],
        memory: AttributedMemoryItem
    ): Promise<{ memory: MemoryEntryRecord; warnings: string[] }>
}

export interface LivingMemoryArchiveProvider {
    archiveActiveMemories(
        presetId: string,
        memoryIds: string[]
    ): Promise<{ archived: number }>
}

export interface SnapshotRepository {
    getLatestSnapshotByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ): Promise<MemorySnapshotRecord | undefined>
    listSnapshotsByPreset(presetId: string): Promise<MemorySnapshotRecord[]>
    upsertSnapshot(
        scope: MemoryScope,
        query: string,
        items: AgenticMemorySnapshotItem[]
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
    createFailedJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        error: unknown,
        startedAt: Date
    ): Promise<MemoryJobRecord>
    updateJob(id: string, patch: Partial<MemoryJobRecord>): Promise<void>
    listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]>
    markStaleRunningJobsAsFailed(
        options?: { presetId?: string; kind?: MemoryJobKind },
        reason?: string
    ): Promise<MemoryJobRecord[]>
}

/**
 * 提取落库面：由应用变更服务实现——windowSpeakers 的注册与记忆追加必须
 * 在同一预设级队列操作内完成，持久化仓储的 appendMemories 只负责事实
 * 写入、不维护注册表覆盖。方法与仓储 appendMemories 刻意不同名：
 * TypeScript 少参方法可结构化兼容多参接口，同名注入会把 windowSpeakers
 * 静默丢弃，缺行回归无法在类型层拦截。windowSpeakers 必填：省略即绕过
 * 铸键不变量，无关联时由调用方显式传空数组。
 */
export interface ExtractionMemoryWriter {
    appendExtractedMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: AttributedMemoryItem[],
        sourceLabel: string,
        windowSpeakers: ExtractionPayload['speakers']
    ): Promise<MemoryEntryRecord[]>
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
    markUserProfileReviewed(
        profileId: string,
        sourceMemoryIds: string[]
    ): Promise<void>
    deleteUserProfile(profileId: string): Promise<void>
}
