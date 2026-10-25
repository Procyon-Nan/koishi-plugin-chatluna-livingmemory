import type {
    LivingMemoryGetMessagesMemory,
    MemoryEntryRecord,
    PresetSpeakerRecord
} from '../../contracts/memory'

type ModelMemoryView = Pick<
    MemoryEntryRecord,
    | 'id'
    | 'type'
    | 'createdAt'
    | 'updatedAt'
    | 'sentiment'
    | 'importance'
    | 'keywords'
    | 'summary'
    | 'sourceLabel'
    | 'content'
>

type MemoryModelField = keyof ModelMemoryView | 'speakerLabels'

export const dreamMemoryFields = [
    'id',
    'type',
    'createdAt',
    'updatedAt',
    'sentiment',
    'importance',
    'keywords',
    'summary',
    'content',
    'speakerLabels'
] as const satisfies readonly MemoryModelField[]

export const contextMemoryFields = [
    'type',
    'updatedAt',
    'sentiment',
    'sourceLabel',
    'content'
] as const satisfies readonly MemoryModelField[]

export const searchMemoryFields = ['id', ...contextMemoryFields] as const

const formatMemoryField = (
    entry: ModelMemoryView & Partial<Pick<MemoryEntryRecord, 'speakerKeys'>>,
    field: MemoryModelField,
    speakers?: ReadonlyMap<string, PresetSpeakerRecord>
): string | null => {
    switch (field) {
        case 'createdAt':
        case 'updatedAt':
            return `${field}=${entry[field].toISOString()}`
        case 'keywords':
            return `keywords=${entry.keywords.join('、')}`
        case 'content':
            return `content:\n${entry.content}`
        case 'speakerLabels': {
            const labels = entry.speakerKeys!.map(
                (key) => speakers!.get(key)!.speakerLabel
            )
            return `speakerLabels=${JSON.stringify(labels)}`
        }
        default: {
            const value = entry[field]
            if (value === null) return null
            const label = field === 'sourceLabel' ? 'source' : field
            return `${label}=${value}`
        }
    }
}

export function renderMemoriesForModel(
    entries: readonly ModelMemoryView[],
    options: { fields: readonly (keyof ModelMemoryView)[] }
): string
export function renderMemoriesForModel(
    entries: readonly (ModelMemoryView &
        Pick<MemoryEntryRecord, 'speakerKeys'>)[],
    options: {
        fields: readonly MemoryModelField[]
        speakers: readonly PresetSpeakerRecord[]
    }
): string
export function renderMemoriesForModel(
    entries: readonly (ModelMemoryView &
        Partial<Pick<MemoryEntryRecord, 'speakerKeys'>>)[],
    options: {
        fields: readonly MemoryModelField[]
        speakers?: readonly PresetSpeakerRecord[]
    }
): string {
    const speakers = options.fields.includes('speakerLabels')
        ? new Map(
              options.speakers!.map((speaker) => [speaker.speakerKey, speaker])
          )
        : undefined
    return entries
        .map((entry) => {
            const lines = options.fields
                .map((field) => formatMemoryField(entry, field, speakers))
                .filter((line) => line !== null)
            return lines.join('\n')
        })
        .join('\n\n---\n\n')
}

// transcriptLines 是提取工作流输入与 <chat_history> 注入共用的原始格式，
// 由 source_serializer 无条件写入、类型与导入边界强制存在，直接作为来源
// 对话的模型视图复用。
export const renderMemorySourceMessagesForModel = (
    memory: LivingMemoryGetMessagesMemory
) => {
    const header = [`id=${memory.id}`]
    if (memory.sourceLabel != null) {
        header.push(`source=${memory.sourceLabel}`)
    }

    if (memory.sourceOrigins.length === 0) {
        return [...header, '（该记忆没有记录来源消息）'].join('\n')
    }

    const originCount = memory.sourceOrigins.length
    const blocks = memory.sourceOrigins.map((origin, index) => {
        const lines = origin.messages.flatMap(
            (message) => message.transcriptLines
        )
        if (originCount > 1) {
            lines.unshift(`来源对话 ${index + 1}/${originCount}：`)
        }
        return lines.join('\n')
    })

    return [...header, blocks.join('\n\n')].join('\n')
}
