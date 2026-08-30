import { BaseMessage } from '@langchain/core/messages'
import type { Context, Session } from 'koishi'
import type { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import type { MemoryScope } from '../../contracts/memory'
import { toNonEmptyString } from '../shared/utils'

export interface QueueExtractionOptions {
    resolvePresetPrompt: () => Promise<string>
    resolveTranscriptHeader: () => Promise<string>
}

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

export interface CharacterMemoryScopeSession {
    isDirect?: boolean
    userId?: string
    guildId?: string
}

const toCharacterSessionId = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined
}

/**
 * Character 集成约定的会话键规则：私聊为 private:{userId}，群聊为 group:{guildId}。
 * 与 chatluna_character 事件 payload 中的 sessionKey 同格式；推导规则唯一实现于此，
 * character 中间件与工具 runtime 共用，避免多处拷贝漂移。
 */
export const toCharacterMemoryConversationId = (
    session: CharacterMemoryScopeSession
) => {
    const id = session.isDirect
        ? toCharacterSessionId(session.userId)
        : toCharacterSessionId(session.guildId)
    if (id == null) {
        return undefined
    }

    return `${session.isDirect ? 'private' : 'group'}:${id}`
}

/**
 * Character 集成约定的预设命名规则：在原始 presetName 上追加 characterPresetSuffix。
 */
export const toCharacterMemoryPresetId = (presetName: string) => {
    return `${presetName}${characterPresetSuffix}`
}

/**
 * ChatLuna AgentRunContext 中本插件消费的字段。agentContext 自
 * 1.4.0-alpha.37 起随工具调用与提示渲染 configurable 下发；扁平的
 * conversationId 字段已在 alpha.44 的 run context 统一重构中移除，
 * agentContext 是会话 id 的唯一可靠来源。
 */
export interface AgentRunContextFields {
    kind?: unknown
    conversationId?: unknown
}

export const toAgentRunContextFields = (
    value: unknown
): AgentRunContextFields | null => {
    if (value == null || typeof value !== 'object') {
        return null
    }
    return value as AgentRunContextFields
}

/**
 * 子代理运行的会话 id 为合成值（subagent:${uuid}），不对应真实用户会话；
 * 记忆工作流（注入、提取、主动创建）均不处理子代理运行。
 */
export const isSubagentRunContext = (value: unknown) => {
    return toAgentRunContextFields(value)?.kind === 'subagent'
}

/**
 * 取主链路运行的会话 id：子代理运行与缺失/空白会话 id 均返回 undefined。
 */
export const resolveMainRunConversationId = (value: unknown) => {
    if (isSubagentRunContext(value)) {
        return undefined
    }
    return toNonEmptyString(toAgentRunContextFields(value)?.conversationId)
}

export const normalizeText = (value: string) => value.trim()

/**
 * 作用域唯一键：presetId 与 conversationId 以换行符拼接。
 * 提取缓冲、召回锁与说话人标签缓存均以该键隔离数据。
 */
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

/**
 * 将渲染后的 preset 系统提示词整理为带说明头的纯文本块，
 * 供提取与召回提示词内嵌角色人设上下文。
 */
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

/**
 * 从 presetId 解析角色名标签：Character 预设去掉后缀，ChatLuna 预设直接使用 presetId。
 */
export const resolveAssistantLabel = (presetId: string): string => {
    if (presetId.endsWith(characterPresetSuffix)) {
        return presetId.slice(0, -characterPresetSuffix.length)
    }
    return presetId
}

/**
 * 解析面向 LLM 的助手标签：优先使用 preset 展示名（presetLabel），
 * 缺省或为空白时回退 presetId。
 */
export const resolveScopeAssistantLabel = (
    scope: Pick<MemoryScope, 'presetLabel' | 'presetId'>
): string => scope.presetLabel?.trim() || scope.presetId

/**
 * 解析预设的系统提示词文本，用于向 LLM 提供角色人设上下文。
 * Character 预设通过 chatluna_character 获取，ChatLuna 预设通过 chatluna.preset 获取。
 */
export const resolvePresetPrompt = async (
    ctx: Context,
    presetId: string
): Promise<string> => {
    if (presetId.endsWith(characterPresetSuffix)) {
        const presetName = presetId.slice(0, -characterPresetSuffix.length)
        const character = (
            ctx as Context & { chatluna_character: CharacterPresetProvider }
        ).chatluna_character
        const preset = await character.preset.getPreset(presetName, false)
        return await renderCharacterPresetPrompt(ctx, preset)
    }

    const preset = ctx.chatluna.preset.getPreset(presetId).value
    return await renderChatLunaPresetPrompt(ctx, preset)
}
