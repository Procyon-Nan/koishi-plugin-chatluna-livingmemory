import { BaseMessage } from '@langchain/core/messages'
import type {
    ExtractionPayload,
    MemoryScope,
    MemorySourceMessage,
    MessageFormatter
} from '../types'
import { takeRecentRounds } from './shared/rounds'

interface FormattedMessage {
    role: MemorySourceMessage['role']
    content: string
    transcriptLines: string[]
}

export const livingMemoryRawContentKey = 'living_memory_raw_content'
const rawContentByMessage = new WeakMap<BaseMessage, string>()

export const setLivingMemoryRawContent = (
    message: BaseMessage,
    rawContent: string
) => {
    const normalized = rawContent.trim()
    if (normalized.length > 0) {
        rawContentByMessage.set(message, normalized)
    }
}

const bracketSpeakerLinePattern = /^\[([^\]]+)\]\s*说\s*[:：]\s*(.*)$/u
const bareSpeakerLinePattern =
    /^([^\s:：\[\]，。！？,.!?]{1,64})\s*说\s*[:：]\s*(.*)$/u

const toStringValue = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null
}

const normalizeBracketSpeaker = (speaker: string) => {
    const parts = speaker
        .split(/[,，]/u)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    return parts[parts.length - 1] ?? speaker.trim()
}

const parseSpeakerLine = (line: string) => {
    const bracketMatched = line.match(bracketSpeakerLinePattern)
    if (bracketMatched != null) {
        return {
            speaker: normalizeBracketSpeaker(bracketMatched[1]),
            content: bracketMatched[2].trim()
        }
    }

    const bareMatched = line.match(bareSpeakerLinePattern)
    if (bareMatched != null) {
        return {
            speaker: bareMatched[1].trim(),
            content: bareMatched[2].trim()
        }
    }

    return null
}

const resolveLivingMemoryTextParts = (message: BaseMessage) => {
    const cachedRawContent = rawContentByMessage.get(message)
    if (cachedRawContent != null) {
        return {
            parts: [cachedRawContent],
            stripSpeakerPrefix: true
        }
    }

    const livingMemoryRawContent = toStringValue(
        message.additional_kwargs?.[livingMemoryRawContentKey]
    )
    if (livingMemoryRawContent != null) {
        return {
            parts: [livingMemoryRawContent],
            stripSpeakerPrefix: true
        }
    }

    const rawContent = toStringValue(message.additional_kwargs?.raw_content)
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

export const toLivingMemoryTextParts = (message: BaseMessage) => {
    return resolveLivingMemoryTextParts(message).parts
}

export const toLivingMemoryCleanLines = (
    message: BaseMessage,
    options: { stripSpeakerPrefix?: boolean } = {}
) => {
    const resolved = resolveLivingMemoryTextParts(message)
    const stripSpeakerPrefix =
        options.stripSpeakerPrefix ?? resolved.stripSpeakerPrefix
    return resolved.parts
        .flatMap((part) => part.replace(/\r\n/g, '\n').split('\n'))
        .map((line) => {
            const trimmed = line.trim()
            const parsed = parseSpeakerLine(trimmed)
            return stripSpeakerPrefix && parsed != null
                ? parsed.content
                : trimmed
        })
        .filter((line) => line.length > 0)
}

const toRawLines = (message: BaseMessage) => {
    return resolveLivingMemoryTextParts(message)
        .parts.flatMap((part) => part.replace(/\r\n/g, '\n').split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

export const toLivingMemorySpeakerLabel = (
    scope: MemoryScope,
    message: BaseMessage
) => {
    const name = toStringValue((message as { name?: unknown }).name)
    if (name != null) {
        return name
    }

    const prefixedSpeaker = toRawLines(message)
        .map((line) => parseSpeakerLine(line)?.speaker)
        .find((speaker): speaker is string => speaker != null)
    if (prefixedSpeaker != null) {
        return prefixedSpeaker
    }

    const id = toStringValue((message as { id?: unknown }).id)
    if (id != null) {
        return id
    }

    return (
        toStringValue(scope.speakerName) ??
        toStringValue(scope.speakerId) ??
        toStringValue(scope.userId) ??
        '用户'
    )
}

const toPresetLabel = (scope: MemoryScope) => {
    return toStringValue(scope.presetLabel) ?? scope.presetId
}

const toFormattedMessage = (
    scope: MemoryScope,
    message: BaseMessage
): FormattedMessage | null => {
    const type = message.getType()
    const cleanLines =
        type === 'ai'
            ? toLivingMemoryCleanLines(message, { stripSpeakerPrefix: false })
            : toLivingMemoryCleanLines(message)
    if (cleanLines.length === 0) {
        return null
    }

    if (type === 'human') {
        const speakerLabel = toLivingMemorySpeakerLabel(scope, message)
        const transcriptLines = cleanLines.map(
            (line) => `${speakerLabel}说：${line}`
        )

        return {
            role: 'user',
            content: transcriptLines.join('\n'),
            transcriptLines
        }
    }

    if (type === 'ai') {
        return {
            role: 'assistant',
            content: cleanLines.join('\n'),
            transcriptLines: cleanLines.map(
                (line) => `${toPresetLabel(scope)}说：${line}`
            )
        }
    }

    return null
}

export class LivingMemoryMessageFormatter implements MessageFormatter {
    takeRecentRounds(messages: BaseMessage[], roundCount: number) {
        return takeRecentRounds(messages, roundCount, 'pair')
    }

    toExtractionPayload(
        scope: MemoryScope,
        messages: BaseMessage[]
    ): ExtractionPayload {
        const formattedMessages = messages
            .map((message) => toFormattedMessage(scope, message))
            .filter((message): message is FormattedMessage => message != null)

        const sourceMessages = formattedMessages.map((message) => ({
            role: message.role,
            content: message.content
        }))

        return {
            input: formattedMessages
                .flatMap((message) => message.transcriptLines)
                .join('\n'),
            sourceMessages
        }
    }
}
