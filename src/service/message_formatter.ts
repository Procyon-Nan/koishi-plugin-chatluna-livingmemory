import { BaseMessage } from '@langchain/core/messages'
import type {
    ExtractionPayload,
    MemoryScope,
    MemorySourceMessage,
    MessageFormatter
} from '../types'

interface FormattedMessage {
    role: MemorySourceMessage['role']
    content: string
    transcriptLines: string[]
}

export const livingMemoryRawContentKey = 'living_memory_raw_content'

const legacyBracketSpeakerPattern = /^\[[^\]]+\]\s*说\s*[:：]\s*/u
const legacyBareSpeakerPattern =
    /^[^\s:：\[\]，。！？,.!?]{2,64}\s*说\s*[:：]\s*/u

const toStringValue = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null
}

const stripLegacySpeakerPrefix = (line: string) => {
    return line
        .replace(legacyBracketSpeakerPattern, '')
        .replace(legacyBareSpeakerPattern, '')
        .trim()
}

const resolveLivingMemoryTextParts = (message: BaseMessage) => {
    const livingMemoryRawContent = toStringValue(
        message.additional_kwargs?.[livingMemoryRawContentKey]
    )
    if (livingMemoryRawContent != null) {
        return {
            parts: [livingMemoryRawContent],
            stripSpeakerPrefix: false
        }
    }

    const rawContent = toStringValue(message.additional_kwargs?.raw_content)
    if (rawContent != null) {
        return {
            parts: [rawContent],
            stripSpeakerPrefix: false
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
            return stripSpeakerPrefix
                ? stripLegacySpeakerPrefix(trimmed)
                : trimmed
        })
        .filter((line) => line.length > 0)
}

const toHumanSpeakerLabel = (scope: MemoryScope, message: BaseMessage) => {
    const name = toStringValue((message as { name?: unknown }).name)
    if (name != null) {
        return name
    }

    const id = toStringValue((message as { id?: unknown }).id)
    if (id != null) {
        return id
    }

    const scopedUserId = toStringValue(scope.userId)
    return scopedUserId ?? '用户'
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
        const speakerLabel = toHumanSpeakerLabel(scope, message)
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
                (line) => `${scope.presetId}: ${line}`
            )
        }
    }

    return null
}

export class LivingMemoryMessageFormatter implements MessageFormatter {
    takeRecentRounds(messages: BaseMessage[], roundCount: number) {
        if (roundCount <= 0) {
            return []
        }

        const selected: BaseMessage[] = []
        let completedRounds = 0
        let hasAssistant = false

        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index]
            selected.unshift(message)

            const type = message.getType()
            if (type === 'ai') {
                hasAssistant = true
                continue
            }

            if (type === 'human' && hasAssistant) {
                completedRounds += 1
                hasAssistant = false

                if (completedRounds >= roundCount) {
                    break
                }
            }
        }

        return completedRounds === 0 ? [] : selected
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
