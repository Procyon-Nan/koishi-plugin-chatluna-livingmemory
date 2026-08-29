import type { BaseMessage } from '@langchain/core/messages'
import type { Session } from 'koishi'
import type { MemoryScope } from '../../contracts/memory'
import { resolveScopeAssistantLabel } from '../memory/helpers'
import { toNonEmptyString } from '../shared/utils'
import {
    createLivingMemoryTranscriptMessageResult,
    toLivingMemoryDate
} from './transcript_message'
import {
    resolveUserSpeaker,
    type UserSpeakerCache
} from './user_speaker'

export const livingMemoryRawContentKey = 'living_memory_raw_content'

const rawContentByMessage = new WeakMap<BaseMessage, string>()

const toRecord = (value: unknown): Record<string, unknown> | null => {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

const getChatLunaMessageCreatedAt = (message: BaseMessage) => {
    const responseMetadata = toRecord(
        (message as { response_metadata?: unknown }).response_metadata
    )
    const chatlunaMetadata = toRecord(responseMetadata?.chatluna)
    return toLivingMemoryDate(chatlunaMetadata?.createdAt)
}

const getMessageTextParts = (message: BaseMessage) => {
    const cachedRawContent = rawContentByMessage.get(message)
    if (cachedRawContent != null) {
        return {
            parts: [cachedRawContent],
            stripSpeakerPrefix: true
        }
    }

    const livingMemoryRawContent = toNonEmptyString(
        message.additional_kwargs?.[livingMemoryRawContentKey]
    )
    if (livingMemoryRawContent != null) {
        return {
            parts: [livingMemoryRawContent],
            stripSpeakerPrefix: true
        }
    }

    const rawContent = toNonEmptyString(message.additional_kwargs?.raw_content)
    if (rawContent != null) {
        return {
            parts: [rawContent],
            stripSpeakerPrefix: true
        }
    }

    if (typeof message.content === 'string') {
        return {
            parts: [message.content],
            stripSpeakerPrefix: true
        }
    }

    if (!Array.isArray(message.content)) {
        return {
            parts: [],
            stripSpeakerPrefix: false
        }
    }

    return {
        parts: message.content
            .map((part) => {
                if (
                    part != null &&
                    typeof part === 'object' &&
                    (part as Record<string, unknown>).type === 'text' &&
                    typeof (part as Record<string, unknown>).text === 'string'
                ) {
                    return (part as { text: string }).text
                }

                return null
            })
            .filter((part): part is string => part != null),
        stripSpeakerPrefix: true
    }
}

export const setLivingMemoryRawContent = (
    message: BaseMessage,
    rawContent: string
) => {
    const normalized = rawContent.trim()
    if (normalized.length === 0) {
        return
    }

    rawContentByMessage.set(message, normalized)
    message.additional_kwargs = {
        ...message.additional_kwargs,
        [livingMemoryRawContentKey]: normalized
    }
}

/**
 * 召回与用户画像只消费最近若干轮：先切窗再转换，避免全量转换，
 * 也避免触碰到窗口外的历史（如 infiniteContext 压缩摘要）。
 * 配对轮次口径与 shared/rounds 的 takeRecentRounds 保持一致——
 * 召回工作流在转换后还会按同一轮数再次开窗。
 */
export const takeRecentChatLunaRounds = (
    messages: BaseMessage[],
    roundCount: number
) => {
    const selected: BaseMessage[] = []
    let completedRounds = 0
    let hasAssistant = false

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        selected.unshift(message)
        const type = message.getType()

        if (type === 'ai') {
            hasAssistant = true
        } else if (type === 'human' && hasAssistant) {
            completedRounds += 1
            hasAssistant = false
            if (completedRounds >= roundCount) {
                break
            }
        }
    }

    return completedRounds === 0 ? [] : selected
}

export const toChatLunaTranscriptMessageResult = async (
    scope: MemoryScope,
    session: Session,
    message: BaseMessage,
    options: {
        fallbackCreatedAt?: Date
        speakerCache?: UserSpeakerCache
    } = {}
) => {
    const type = message.getType()
    if (type !== 'human' && type !== 'ai') {
        return {
            message: null,
            reason: 'unsupported-role' as const
        }
    }

    const resolved = getMessageTextParts(message)
    const createdAt =
        getChatLunaMessageCreatedAt(message) ?? options.fallbackCreatedAt
    if (type === 'ai') {
        return createLivingMemoryTranscriptMessageResult({
            role: 'assistant',
            speakerLabel: resolveScopeAssistantLabel(scope),
            content: resolved.parts,
            createdAt,
            stripSpeakerPrefix: false
        })
    }

    const speakerId = toNonEmptyString(message.id)
    if (speakerId == null) {
        throw new Error('ChatLuna user message has no id for speaker lookup.')
    }

    const speaker = await resolveUserSpeaker(
        session,
        speakerId,
        options.speakerCache
    )
    return createLivingMemoryTranscriptMessageResult({
        role: 'user',
        speakerKey: speaker.speakerKey,
        speakerLabel: speaker.speakerLabel,
        content: resolved.parts,
        createdAt,
        stripSpeakerPrefix: resolved.stripSpeakerPrefix
    })
}

export const toChatLunaTranscriptMessages = async (
    scope: MemoryScope,
    session: Session,
    messages: BaseMessage[],
    speakerCache: UserSpeakerCache = new Map()
) => {
    const converted = await Promise.all(
        messages.map((message) =>
            toChatLunaTranscriptMessageResult(scope, session, message, {
                speakerCache
            })
        )
    )
    return converted.flatMap((item) =>
        item.message == null ? [] : [item.message]
    )
}
