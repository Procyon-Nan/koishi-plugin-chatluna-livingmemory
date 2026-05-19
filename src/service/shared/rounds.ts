import type { BaseMessage } from '@langchain/core/messages'

export type TakeRecentRoundsMode = 'pair' | 'ai-anchored'

export const takeRecentRounds = (
    messages: BaseMessage[],
    roundCount: number,
    mode: TakeRecentRoundsMode = 'pair'
): BaseMessage[] => {
    if (roundCount <= 0) {
        return []
    }

    if (mode === 'ai-anchored') {
        return takeAiAnchoredRounds(messages, roundCount)
    }

    return takePairRounds(messages, roundCount)
}

const takePairRounds = (
    messages: BaseMessage[],
    roundCount: number
): BaseMessage[] => {
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

const takeAiAnchoredRounds = (
    messages: BaseMessage[],
    roundCount: number
): BaseMessage[] => {
    let lastAiIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].getType() === 'ai') {
            lastAiIndex = index
            break
        }
    }

    if (lastAiIndex < 0) {
        return []
    }

    let completedRounds = 0
    let hasAiInCurrentRound = false
    let hasHumanInCurrentRound = false

    for (let index = lastAiIndex; index >= 0; index--) {
        const type = messages[index].getType()
        if (type === 'ai') {
            if (hasAiInCurrentRound && hasHumanInCurrentRound) {
                completedRounds += 1
                if (completedRounds >= roundCount) {
                    return messages.slice(index + 1, lastAiIndex + 1)
                }
                hasHumanInCurrentRound = false
            }
            hasAiInCurrentRound = true
            continue
        }

        if (type === 'human' && hasAiInCurrentRound) {
            hasHumanInCurrentRound = true
        }
    }

    if (hasAiInCurrentRound && hasHumanInCurrentRound) {
        return messages.slice(0, lastAiIndex + 1)
    }

    return []
}
