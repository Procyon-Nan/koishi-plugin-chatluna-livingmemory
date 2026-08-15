import type { BaseMessage } from '@langchain/core/messages'
import type { MemoryScope } from '../../contracts/memory'
import { resolveScopeAssistantLabel } from '../memory/helpers'
import { toNonEmptyString } from '../shared/utils'
import {
    createLivingMemoryTranscriptMessageResult,
    parseLivingMemorySpeakerLine,
    toLivingMemoryDate
} from './transcript_message'

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

const getMessageRawLines = (message: BaseMessage) => {
    return getMessageTextParts(message)
        .parts.flatMap((part) => part.replace(/\r\n/g, '\n').split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

const getUserSpeakerLabel = (scope: MemoryScope, message: BaseMessage) => {
    const name = toNonEmptyString((message as { name?: unknown }).name)
    if (name != null) {
        return name
    }

    const prefixedSpeaker = getMessageRawLines(message)
        .map((line) => parseLivingMemorySpeakerLine(line)?.speaker)
        .find((speaker): speaker is string => speaker != null)
    if (prefixedSpeaker != null) {
        return prefixedSpeaker
    }

    const id = toNonEmptyString((message as { id?: unknown }).id)
    if (id != null) {
        return id
    }

    return (
        toNonEmptyString(scope.speakerName) ??
        toNonEmptyString(scope.speakerId) ??
        toNonEmptyString(scope.userId) ??
        '用户'
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

    rawContentByMessage.set(message, normalized)
    message.additional_kwargs = {
        ...message.additional_kwargs,
        [livingMemoryRawContentKey]: normalized
    }
}

export const toChatLunaTranscriptMessageResult = (
    scope: MemoryScope,
    message: BaseMessage,
    options: { fallbackCreatedAt?: Date } = {}
) => {
    const type = message.getType()
    if (type !== 'human' && type !== 'ai') {
        return {
            message: null,
            reason: 'unsupported-role' as const
        }
    }

    const resolved = getMessageTextParts(message)
    return createLivingMemoryTranscriptMessageResult({
        role: type === 'human' ? 'user' : 'assistant',
        speakerLabel:
            type === 'human'
                ? getUserSpeakerLabel(scope, message)
                : resolveScopeAssistantLabel(scope),
        content: resolved.parts,
        createdAt:
            getChatLunaMessageCreatedAt(message) ?? options.fallbackCreatedAt,
        stripSpeakerPrefix:
            type === 'human' ? resolved.stripSpeakerPrefix : false
    })
}

export const toChatLunaTranscriptMessages = (
    scope: MemoryScope,
    messages: BaseMessage[]
) => {
    return messages
        .map((message) => toChatLunaTranscriptMessageResult(scope, message))
        .flatMap((converted) =>
            converted.message == null ? [] : [converted.message]
        )
}
