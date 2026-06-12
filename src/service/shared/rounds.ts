import type { LivingMemoryTranscriptMessage } from '../../types'

export type TakeRecentRoundsMode = 'pair' | 'ai-anchored'

export const takeRecentRounds = (
    messages: LivingMemoryTranscriptMessage[],
    roundCount: number,
    mode: TakeRecentRoundsMode = 'pair'
): LivingMemoryTranscriptMessage[] => {
    if (roundCount <= 0) {
        return []
    }

    if (mode === 'ai-anchored') {
        return takeAiAnchoredRounds(messages, roundCount)
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

const takeAiAnchoredRounds = (
    messages: LivingMemoryTranscriptMessage[],
    roundCount: number
): LivingMemoryTranscriptMessage[] => {
    let lastAssistantIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === 'assistant') {
            lastAssistantIndex = index
            break
        }
    }

    if (lastAssistantIndex < 0) {
        return []
    }

    let completedRounds = 0
    let hasAssistantInCurrentRound = false
    let hasUserInCurrentRound = false

    for (let index = lastAssistantIndex; index >= 0; index--) {
        const role = messages[index].role
        if (role === 'assistant') {
            if (hasAssistantInCurrentRound && hasUserInCurrentRound) {
                completedRounds += 1
                if (completedRounds >= roundCount) {
                    return messages.slice(index + 1, lastAssistantIndex + 1)
                }
                hasUserInCurrentRound = false
            }
            hasAssistantInCurrentRound = true
            continue
        }

        if (role === 'user' && hasAssistantInCurrentRound) {
            hasUserInCurrentRound = true
        }
    }

    if (hasAssistantInCurrentRound && hasUserInCurrentRound) {
        return messages.slice(0, lastAssistantIndex + 1)
    }

    return []
}
