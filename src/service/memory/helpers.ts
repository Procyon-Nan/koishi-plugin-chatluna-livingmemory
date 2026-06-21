import { BaseMessage } from '@langchain/core/messages'
import type { LivingMemoryTranscriptMessage, MemoryScope } from '../../types'

export interface QueueExtractionOptions {
    presetPromptOverride?: string | null
    preselectedMessages?: LivingMemoryTranscriptMessage[]
}

export type DebugLogger = (message: string) => void

export interface CharacterPresetProvider {
    preset?: {
        getAllPreset?: () => Promise<unknown>
        getPreset?: (
            presetName: string,
            loadForDisk?: boolean,
            throwError?: boolean
        ) => Promise<unknown>
    }
}

export const characterPresetSuffix = '（Character）'

export const normalizeText = (value: string) => value.trim()

export const scopeKey = (
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
) => `${scope.presetId}\n${scope.conversationId}`

export const toPresetIdList = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
        return []
    }

    return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
}

export const mergePresetIds = (...groups: string[][]): string[] => {
    const result: string[] = []
    const seen = new Set<string>()

    for (const group of groups) {
        for (const id of group) {
            if (seen.has(id)) {
                continue
            }

            seen.add(id)
            result.push(id)
        }
    }

    return result
}

export const formatMemoryItemsForLog = (
    items: { content: string; score?: number }[]
) => {
    if (items.length === 0) {
        return '[]'
    }

    return items
        .map((item, index) => {
            const score = item.score == null ? '' : ` score=${item.score}`
            return `${index + 1}.${score} ${item.content}`
        })
        .join('\n')
}

const stringifyMessageContent = (content: unknown) => {
    if (typeof content === 'string') {
        return content.trim()
    }

    if (!Array.isArray(content)) {
        return ''
    }

    return content
        .map((part) => {
            if (
                part != null &&
                typeof part === 'object' &&
                typeof (part as Record<string, unknown>).text === 'string'
            ) {
                return (part as { text: string }).text.trim()
            }

            return ''
        })
        .filter((part) => part.length > 0)
        .join('\n')
}

export const formatRenderedPresetPrompt = (messages: BaseMessage[]) => {
    const formattedMessages = messages
        .filter((message) => message.getType() === 'system')
        .map((message) => {
            const content = stringifyMessageContent(message.content)
            if (content.length === 0) {
                return null
            }

            return content
        })
        .filter((message): message is string => message != null)

    if (formattedMessages.length === 0) {
        return null
    }

    return [
        '# 当前 preset prompt（仅用于理解“我”的人设，不要从此处抽取记忆）',
        ...formattedMessages
    ].join('\n\n')
}
