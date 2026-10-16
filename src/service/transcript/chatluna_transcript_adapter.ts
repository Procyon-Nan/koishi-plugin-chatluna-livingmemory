import type { BaseMessage } from '@langchain/core/messages'
import type { Session } from 'koishi'
import type { MemoryScope } from '../../contracts/memory'
import { resolveScopeAssistantLabel } from '../memory/helpers'
import { toNonEmptyString } from '../shared/utils'
import {
    createLivingMemoryTranscriptMessageResult,
    toLivingMemoryDate
} from './transcript_message'
import { resolveUserSpeaker, type UserSpeakerCache } from './user_speaker'

export const livingMemoryRawContentKey = 'living_memory_raw_content'

const toRecord = (value: unknown): Record<string, unknown> | null => {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

export const getChatLunaMessageCreatedAt = (message: BaseMessage) => {
    const chatlunaMetadata = toRecord(message.response_metadata.chatluna)
    return toLivingMemoryDate(chatlunaMetadata?.createdAt)
}

export const getMessageTextParts = (message: BaseMessage) => {
    const livingMemoryRawContent = toNonEmptyString(
        message.additional_kwargs[livingMemoryRawContentKey]
    )
    if (livingMemoryRawContent != null) {
        return [livingMemoryRawContent]
    }

    const rawContent = toNonEmptyString(message.additional_kwargs.raw_content)
    if (rawContent != null) {
        return [rawContent]
    }

    if (typeof message.content === 'string') {
        return [message.content]
    }

    return message.content.flatMap((part) =>
        part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    )
}

export const setLivingMemoryRawContent = (
    message: BaseMessage,
    rawContent: string
) => {
    const normalized = rawContent.trim()
    if (normalized.length === 0) {
        return
    }

    message.additional_kwargs = {
        ...message.additional_kwargs,
        [livingMemoryRawContentKey]: normalized
    }
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

    const content = getMessageTextParts(message)
    const createdAt =
        getChatLunaMessageCreatedAt(message) ?? options.fallbackCreatedAt
    if (type === 'ai') {
        return createLivingMemoryTranscriptMessageResult({
            role: 'assistant',
            speakerLabel: resolveScopeAssistantLabel(scope),
            content,
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
        content,
        createdAt,
        stripSpeakerPrefix: true
    })
}
