import type {
    LivingMemoryGetMessagesMemory,
    MemoryEntryType
} from '../../contracts/memory'
import type { DreamMemoryEntryRecord } from '../../contracts/workflows'

export const formatMemoryEntryForPrompt = (entry: DreamMemoryEntryRecord) => {
    return [
        `id=${entry.id}`,
        `type=${entry.type}`,
        `createdAt=${entry.createdAt.toISOString()}`,
        `updatedAt=${entry.updatedAt.toISOString()}`,
        `sentiment=${entry.sentiment ?? ''}`,
        `importance=${entry.importance ?? ''}`,
        `keywords=${entry.keywords.join('、')}`,
        `summary=${entry.summary ?? ''}`,
        'content:',
        entry.content
    ].join('\n')
}

// 送入模型阅读的记忆字段集，由人物画像提示词与 living_memory_search 工具共用。
export interface ModelMemoryView {
    id: string
    type: MemoryEntryType
    content: string
    sentiment: string | null
    sourceLabel: string | null
    updatedAt: Date
}

const modelMemoryViewSeparator = '\n\n---\n\n'

export const renderMemoriesForModel = (
    entries: ModelMemoryView[],
    options: { includeId: boolean }
) => {
    return entries
        .map((entry) =>
            [
                ...(options.includeId ? [`id=${entry.id}`] : []),
                `type=${entry.type}`,
                `updatedAt=${entry.updatedAt.toISOString()}`,
                ...(entry.sentiment == null
                    ? []
                    : [`sentiment=${entry.sentiment}`]),
                ...(entry.sourceLabel == null
                    ? []
                    : [`source=${entry.sourceLabel}`]),
                'content:',
                entry.content
            ].join('\n')
        )
        .join(modelMemoryViewSeparator)
}

// transcriptLines 是提取工作流输入与 <chat_history> 注入共用的原始格式，
// 由 source_serializer 无条件写入、类型与导入边界强制存在，直接作为来源
// 对话的模型视图复用。
export const renderMemorySourceMessagesForModel = (
    memory: LivingMemoryGetMessagesMemory
) => {
    const header = [
        `id=${memory.id}`,
        ...(memory.sourceLabel == null ? [] : [`source=${memory.sourceLabel}`])
    ]

    if (memory.sourceOrigins.length === 0) {
        return [...header, '（该记忆没有记录来源消息）'].join('\n')
    }

    const originCount = memory.sourceOrigins.length
    const blocks = memory.sourceOrigins.map((origin, index) => {
        const lines = [
            ...(originCount > 1
                ? [`来源对话 ${index + 1}/${originCount}：`]
                : []),
            ...origin.messages.flatMap((message) => message.transcriptLines)
        ]
        return lines.join('\n')
    })

    return [...header, blocks.join('\n\n')].join('\n')
}
