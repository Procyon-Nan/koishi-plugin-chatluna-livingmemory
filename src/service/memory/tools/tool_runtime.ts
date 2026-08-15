import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { MemoryScope } from '../../../contracts/memory'
import {
    toCharacterMemoryConversationId,
    toCharacterMemoryPresetId
} from '../helpers'
import { toNonEmptyString } from '../../shared/utils'

export type LivingMemoryToolConfigurable = {
    preset?: unknown
    conversationId?: unknown
    source?: unknown
    session?: unknown
}

export const getLivingMemoryToolConfigurable = (
    runConfig?: ToolRunnableConfig
) => {
    return runConfig?.configurable as LivingMemoryToolConfigurable | undefined
}

interface LivingMemoryToolSessionFields {
    userId?: string
    channelId?: string
    guildId?: string
    isDirect?: boolean
}

const toToolSessionFields = (
    value: unknown
): LivingMemoryToolSessionFields | null => {
    if (value == null || typeof value !== 'object') {
        return null
    }

    const session = value as Record<string, unknown>
    return {
        userId: toNonEmptyString(session.userId),
        channelId: toNonEmptyString(session.channelId),
        guildId: toNonEmptyString(session.guildId),
        isDirect: session.isDirect === true
    }
}

const isCharacterToolSource = (configurable: LivingMemoryToolConfigurable) => {
    return configurable.source === 'character'
}

export type LivingMemoryToolPresetIdResolution =
    { ok: true; presetId: string } | { ok: false; reason: 'missing-preset' }

/**
 * 解析工具调用所属的记忆预设。
 *
 * ChatLuna 主链路传入原始 preset；Character 链路传入未加后缀的
 * presetName，而 Character 记忆统一存于带 characterPresetSuffix 的
 * 预设下，因此此处按 source 判别补后缀。
 */
export const resolveToolMemoryPresetId = (
    configurable: LivingMemoryToolConfigurable | undefined
): LivingMemoryToolPresetIdResolution => {
    const preset = toNonEmptyString(configurable?.preset)
    if (preset == null) {
        return { ok: false, reason: 'missing-preset' }
    }

    if (isCharacterToolSource(configurable)) {
        return { ok: true, presetId: toCharacterMemoryPresetId(preset) }
    }
    return { ok: true, presetId: preset }
}

export type LivingMemoryToolScopeResolution =
    | { ok: true; scope: MemoryScope }
    | {
          ok: false
          reason:
              | 'missing-preset'
              | 'missing-conversation-id'
              | 'missing-session'
              | 'missing-session-key'
      }

/**
 * 从工具 runtime configurable 重建 MemoryScope。
 *
 * ChatLuna 主链路：preset 与 conversationId 直接采用（configurable 由
 * agent_chat_chain 以 preset.triggerKeyword[0] 与会话 id 构造）。
 * Character 链路：conversationId 为平台前缀格式，presetName 无后缀，
 * 因此按 character_middleware 的规则用 session 重算会话键并补后缀。
 */
export const resolveToolMemoryScopeConfigurable = (
    configurable: LivingMemoryToolConfigurable | undefined
): LivingMemoryToolScopeResolution => {
    const presetIdResolution = resolveToolMemoryPresetId(configurable)
    if (presetIdResolution.ok === false) {
        return presetIdResolution
    }

    const session = toToolSessionFields(configurable?.session)

    if (isCharacterToolSource(configurable)) {
        if (session === null) {
            return { ok: false, reason: 'missing-session' }
        }

        const conversationId = toCharacterMemoryConversationId(session)
        if (conversationId == null) {
            return { ok: false, reason: 'missing-session-key' }
        }

        return {
            ok: true,
            scope: {
                conversationId,
                presetId: presetIdResolution.presetId,
                userId: session.userId,
                channelId: session.channelId,
                guildId: session.guildId,
                isDirect: session.isDirect,
                speakerId: session.userId
            }
        }
    }

    const conversationId = toNonEmptyString(configurable?.conversationId)
    if (conversationId == null) {
        return { ok: false, reason: 'missing-conversation-id' }
    }

    return {
        ok: true,
        scope: {
            conversationId,
            presetId: presetIdResolution.presetId,
            userId: session?.userId,
            channelId: session?.channelId,
            guildId: session?.guildId,
            isDirect: session?.isDirect,
            speakerId: session?.userId
        }
    }
}

export const describeLivingMemoryToolScopeFailure = (
    reason: Exclude<LivingMemoryToolScopeResolution, { ok: true }>['reason']
) => {
    switch (reason) {
        case 'missing-preset':
            return 'Missing preset in the current tool call.'
        case 'missing-conversation-id':
            return 'Missing conversationId in the current tool call.'
        case 'missing-session':
            return 'Missing session in the current tool call.'
        case 'missing-session-key':
            return 'Missing user or guild id of the character session in the current tool call.'
    }
}
