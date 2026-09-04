import type { MemoryEntryType } from '../../contracts/memory'
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
                'content:',
                entry.content
            ].join('\n')
        )
        .join(modelMemoryViewSeparator)
}
