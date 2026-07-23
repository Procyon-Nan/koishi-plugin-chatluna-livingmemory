import type { LivingMemoryTranscriptMessage } from '../../contracts/memory'

export const takeRecentRounds = (
    messages: LivingMemoryTranscriptMessage[],
    roundCount: number
): LivingMemoryTranscriptMessage[] => {
    if (roundCount <= 0) {
        return []
    }

    return takePairRounds(messages, roundCount)
}

const takePairRounds = (
    messages: LivingMemoryTranscriptMessage[],
    roundCount: number
): LivingMemoryTranscriptMessage[] => {
    const selected: LivingMemoryTranscriptMessage[] = []
    let completedRounds = 0
    let hasAssistant = false

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        selected.unshift(message)

        if (message.role === 'assistant') {
            hasAssistant = true
            continue
        }

        if (message.role === 'user' && hasAssistant) {
            completedRounds += 1
            hasAssistant = false

            if (completedRounds >= roundCount) {
                break
            }
        }
    }

    return completedRounds === 0 ? [] : selected
}
