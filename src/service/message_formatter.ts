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

const prefixedUserLinePattern = /^\[[^\]]+\]说:\s*(.*)$/s

const toTextParts = (message: BaseMessage) => {
    if (typeof message.content === 'string') {
        return [message.content]
    }

    if (!Array.isArray(message.content)) {
        return []
    }

    return message.content
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
        .filter((part): part is string => part != null)
}

const toCleanLines = (message: BaseMessage) => {
    return toTextParts(message)
        .flatMap((part) => part.replace(/\r\n/g, '\n').split('\n'))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

const hasUsablePrefixedUserLine = (line: string) => {
    const matched = line.match(prefixedUserLinePattern)
    return matched != null && matched[1].trim().length > 0
}

const formatUserLine = (line: string, fallbackLabel: string) => {
    if (line.match(prefixedUserLinePattern) != null) {
        return hasUsablePrefixedUserLine(line) ? line : null
    }

    return `${fallbackLabel} ${line}`
}

const toUserFallbackLabel = (scope: MemoryScope) => {
    if (scope.userId != null && scope.userId.length > 0) {
        return `[${scope.userId}]说:`
    }

    return '用户:'
}

const toFormattedMessage = (
    scope: MemoryScope,
    message: BaseMessage
): FormattedMessage | null => {
    const type = message.getType()
    const cleanLines = toCleanLines(message)
    if (cleanLines.length === 0) {
        return null
    }

    if (type === 'human') {
        const fallbackLabel = toUserFallbackLabel(scope)
        const transcriptLines = cleanLines
            .map((line) => formatUserLine(line, fallbackLabel))
            .filter((line): line is string => line != null)

        if (transcriptLines.length === 0) {
            return null
        }

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
