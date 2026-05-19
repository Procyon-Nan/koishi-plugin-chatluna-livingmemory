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
    createdAt: Date
    updatedAt: Date
}

export interface MemorySnapshotRecord {
    id: string
    presetId: string
    conversationId: string
    strategy: string
    query: string
    items: MemoryReference[]
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

export interface MemoryJobRecord {
    id: string
    presetId: string
    conversationId: string
    kind: string
    status: string
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

export type ChatLunaConversationRouteMode =
    | 'personal'
    | 'shared'
    | 'custom'
    | 'unknown'

export type ChatLunaConversationStatus =
    | 'active'
    | 'archived'
    | 'deleted'
    | 'broken'

export interface ChatLunaConversationRouteInfo {
    mode: ChatLunaConversationRouteMode
    baseBindingKey: string
    presetLane?: string | null
    platform?: string | null
    selfId?: string | null
    userId?: string | null
    guildId?: string | null
    routeKey?: string | null
    isDirect?: boolean | null
}

export interface ChatLunaConversationListQuery {
    keyword?: string
    page?: number
    pageSize?: number
}

export interface ChatLunaModelOption {
    label: string
    value: string
    platform: string
    name: string
}

export interface ChatLunaPresetOption {
    label: string
    value: string
}

export interface ChatLunaConversationOptions {
    models: ChatLunaModelOption[]
    presets: ChatLunaPresetOption[]
}

export interface ChatLunaConversationListItem {
    id: string
    seq?: number
    bindingKey: string
    title: string
    model: string
    preset: string
    chatMode: string
    createdBy: string
    createdAt: Date
    updatedAt: Date
    lastChatAt?: Date | null
    status: ChatLunaConversationStatus
    isCurrent: boolean
    activeConversationId?: string | null
    route: ChatLunaConversationRouteInfo
}

export interface UpdateChatLunaConversationUsageInput {
    conversationId: string
    model?: string
    preset?: string
}

export interface DeleteChatLunaConversationInput {
    conversationId: string
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
        'living-memory/runDream': (
            presetId: string
        ) => DreamTriggerResult
        'living-memory/clearPresetData': (
            presetId: string
        ) => { success: true }
        'living-memory/listChatLunaConversations': (
            query: ChatLunaConversationListQuery
        ) => PageResult<ChatLunaConversationListItem>
        'living-memory/listChatLunaConversationOptions': () => ChatLunaConversationOptions
        'living-memory/updateChatLunaConversationUsage': (
            input: UpdateChatLunaConversationUsageInput
        ) => ChatLunaConversationListItem
        'living-memory/deleteChatLunaConversation': (
            input: DeleteChatLunaConversationInput
        ) => { success: true }
    }
}
