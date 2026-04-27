import { BaseMessage } from '@langchain/core/messages'
import type {
    ExtractionPayload,
    MemorySourceMessage,
    MessageFormatter
} from '../types'

const toMessageRole = (message: BaseMessage): MemorySourceMessage['role'] => {
    const type = message.getType()

    if (type === 'human') {
        return 'user'
    }

    if (type === 'ai') {
        return 'assistant'
    }

    return 'system'
}

const toMessageContent = (message: BaseMessage) => {
    return typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)
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

    toExtractionPayload(messages: BaseMessage[]): ExtractionPayload {
        const sourceMessages = messages.map((message) => ({
            role: toMessageRole(message),
            content: toMessageContent(message)
        }))

        return {
            input: sourceMessages
                .map((message) => `${message.role}: ${message.content}`)
                .join('\n'),
            sourceMessages
        }
    }
}
