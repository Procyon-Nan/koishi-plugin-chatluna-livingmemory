import { BaseMessage } from '@langchain/core/messages'
import type { Context, Session } from 'koishi'
import type { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../contracts/memory'

export interface QueueExtractionOptions {
    resolvePresetPrompt: () => Promise<string>
    preselectedMessages?: LivingMemoryTranscriptMessage[]
}

export type DebugLogger = (message: string) => void

export interface CharacterPresetPromptSource {
    system: {
        rawString: string
    }
}

export interface CharacterPresetProvider {
    preset: {
        getAllPreset?: () => Promise<unknown>
        getPreset: (
            presetName: string,
            loadForDisk?: boolean,
            throwError?: boolean
        ) => Promise<CharacterPresetPromptSource>
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
        .map((message) => stringifyMessageContent(message.content))

    return [
        '# 当前 preset prompt（仅用于理解“我”的人设，不要从此处抽取记忆）',
        ...formattedMessages
    ].join('\n\n')
}

export const renderChatLunaPresetPrompt = async (
    ctx: Context,
    presetTemplate: PresetTemplate,
    variables: Record<string, unknown> = {}
) => {
    const rendered = await ctx.chatluna.promptRenderer.renderPresetTemplate(
        presetTemplate,
        variables
    )

    return formatRenderedPresetPrompt(rendered.messages)
}

export const renderCharacterPresetPrompt = async (
    ctx: Context,
    preset: CharacterPresetPromptSource,
    options: {
        session?: Session
    } = {}
) => {
    const rendered = await ctx.chatluna.promptRenderer.renderTemplate(
        preset.system.rawString,
        {
            time: '',
            stickers: '',
            status: ''
        },
        options.session == null
            ? undefined
            : {
                  configurable: {
                      session: options.session
                  }
              }
    )

    return rendered.text.trim()
}
