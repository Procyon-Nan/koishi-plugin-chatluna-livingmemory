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

export interface MemorySourceMessage {
    role: 'user' | 'assistant' | 'system'
    speakerLabel?: string
    contentLines?: string[]
    createdAt?: string
    transcriptLines?: string[]
    content: string
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
    broadSearchTexts: string[]
    specificSearchTexts?: string[]
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
    matchedBroadSearchTexts: string[]
    matchedSpecificSearchTexts: string[]
}

export interface AgenticMemorySnapshotItem {
    finalText: string
    toolCallSummary: AgenticMemorySearchToolCallSummary
    matchedBroadSearchTexts: string[]
    matchedSpecificSearchTexts: string[]
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
    createdAt: Date
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
    | 'rerank-model-missing'
    | 'extract-model-missing'
    | 'recall-rewrite-model-missing'
    | 'agentic-recall-model-missing'

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

export interface PageResult<T> {
    items: T[]
    page: number
    pageSize: number
    total: number
}

declare module '@koishijs/client' {
    interface Events {
        'living-memory/listPresetIds': () => string[]
        'living-memory/getStatus': () => MemoryServiceStatus
        'living-memory/listMemories': (
            query: {
                presetId: string
                type?: MemoryEntryType
                status?: MemoryEntryStatus | 'all'
                keyword?: string
                page?: number
                pageSize?: number
            }
        ) => PageResult<MemoryEntryRecord>
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
        'living-memory/deleteMemory': (
            memoryId: string
        ) => { success: true }
        'living-memory/listSnapshots': (
            query: {
                presetId: string
                conversationId?: string
                page?: number
                pageSize?: number
            }
        ) => PageResult<MemorySnapshotRecord>
        'living-memory/deleteSnapshot': (
            snapshotId: string
        ) => { success: true }
        'living-memory/listJobs': (
            query: {
                presetId: string
                kind?: string
                status?: string
                page?: number
                pageSize?: number
            }
        ) => PageResult<MemoryJobRecord>
        'living-memory/listUserProfiles': (
            query: {
                presetId: string
                page?: number
                pageSize?: number
            }
        ) => PageResult<UserProfileRecord>
        'living-memory/deleteUserProfile': (
            profileId: string
        ) => { success: true }
        'living-memory/runDream': (
            presetId: string
        ) => DreamTriggerResult
        'living-memory/clearPresetData': (
            presetId: string
        ) => { success: true }
    }
}
