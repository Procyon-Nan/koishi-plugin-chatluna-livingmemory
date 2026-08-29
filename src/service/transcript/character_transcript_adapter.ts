import type { Session } from 'koishi'
import type {
    LivingMemoryCompletedRound,
    MemoryScope
} from '../../contracts/memory'
import { resolveScopeAssistantLabel } from '../memory/helpers'
import { toNonEmptyString } from '../shared/utils'
import { createLivingMemoryTranscriptMessageResult } from './transcript_message'
import {
    resolveUserSpeaker,
    type UserSpeakerCache
} from './user_speaker'

export interface CharacterTranscriptSourceMessage {
    content: string
    name?: string
    id?: string
    messageId?: string
    timestamp?: number
}

const requireCharacterUserId = (message: CharacterTranscriptSourceMessage) => {
    const userId = toNonEmptyString(message.id)
    if (userId == null) {
        throw new Error(
            'Character user message has no id for global speaker lookup.'
        )
    }

    return userId
}

export const isCharacterBotMessage = (
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    const messageId = toNonEmptyString(message.id)
    const botIds = [session.bot?.selfId, session.selfId]
        .map((id) => toNonEmptyString(id))
        .filter((id): id is string => id != null)

    if (messageId != null && botIds.length > 0) {
        return botIds.includes(messageId)
    }

    const messageName = toNonEmptyString(message.name)
    const botName = toNonEmptyString(session.bot?.user?.name)
    return messageName != null && botName != null && messageName === botName
}

export const isSameCharacterMessage = (
    left: CharacterTranscriptSourceMessage,
    right?: CharacterTranscriptSourceMessage
) => {
    if (right == null) {
        return false
    }

    if (left === right) {
        return true
    }

    const leftMessageId = toNonEmptyString(left.messageId)
    const rightMessageId = toNonEmptyString(right.messageId)
    if (
        leftMessageId != null &&
        rightMessageId != null &&
        leftMessageId === rightMessageId &&
        left.id === right.id
    ) {
        return true
    }

    return (
        left.id === right.id &&
        left.timestamp === right.timestamp &&
        left.content === right.content
    )
}

/**
 * 召回与用户画像只消费最近若干轮：先切窗再转换，避免全量转换。
 * 配对轮次口径与 shared/rounds 的 takeRecentRounds 保持一致——
 * 召回工作流在转换后还会按同一轮数再次开窗。
 */
export const takeRecentCharacterRounds = (
    session: Session,
    messages: readonly CharacterTranscriptSourceMessage[],
    roundCount: number
) => {
    const selected: CharacterTranscriptSourceMessage[] = []
    let completedRounds = 0
    let hasAssistant = false

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        selected.unshift(message)

        if (isCharacterBotMessage(session, message)) {
            hasAssistant = true
        } else if (hasAssistant) {
            completedRounds += 1
            hasAssistant = false
            if (completedRounds >= roundCount) {
                break
            }
        }
    }

    return completedRounds === 0 ? [] : selected
}

export const toCharacterTranscriptMessageResult = async (
    scope: MemoryScope,
    session: Session,
    message: CharacterTranscriptSourceMessage,
    cache?: UserSpeakerCache
) => {
    const isAssistant = isCharacterBotMessage(session, message)
    if (isAssistant) {
        return createLivingMemoryTranscriptMessageResult({
            role: 'assistant',
            speakerLabel: resolveScopeAssistantLabel(scope),
            content: message.content,
            createdAt: message.timestamp,
            stripSpeakerPrefix: false
        })
    }

    const speaker = await resolveUserSpeaker(
        session,
        requireCharacterUserId(message),
        cache
    )
    return createLivingMemoryTranscriptMessageResult({
        role: 'user',
        speakerKey: speaker.speakerKey,
        speakerLabel: speaker.speakerLabel,
        content: message.content,
        createdAt: message.timestamp,
        stripSpeakerPrefix: true
    })
}

export const toCharacterTranscriptMessages = async (
    scope: MemoryScope,
    session: Session,
    messages: readonly CharacterTranscriptSourceMessage[]
) => {
    const cache: UserSpeakerCache = new Map()
    const converted = await Promise.all(
        messages.map((message) =>
            toCharacterTranscriptMessageResult(scope, session, message, cache)
        )
    )

    return converted.flatMap((item) =>
        item.message == null ? [] : [item.message]
    )
}

export type CharacterCompletedRoundInvalidReason =
    | 'focus-is-assistant'
    | 'assistant-response-missing'
    | 'missing-created-at'
    | 'missing-speaker'
    | 'empty-content'

export type CharacterCompletedRoundResult =
    | {
          round: LivingMemoryCompletedRound
          reason: null
      }
    | {
          round: null
          reason: CharacterCompletedRoundInvalidReason
      }

const findLastCharacterMessageIndex = (
    messages: readonly CharacterTranscriptSourceMessage[],
    target: CharacterTranscriptSourceMessage
) => {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (isSameCharacterMessage(messages[index], target)) {
            return index
        }
    }

    return -1
}

const findLastCharacterBotMessageIndex = (
    session: Session,
    messages: readonly CharacterTranscriptSourceMessage[],
    minimumIndex: number
) => {
    for (let index = messages.length - 1; index >= minimumIndex; index--) {
        if (isCharacterBotMessage(session, messages[index])) {
            return index
        }
    }

    return -1
}

export const toCharacterCompletedRound = async (
    scope: MemoryScope,
    session: Session,
    messages: readonly CharacterTranscriptSourceMessage[],
    focusMessage: CharacterTranscriptSourceMessage
): Promise<CharacterCompletedRoundResult> => {
    if (isCharacterBotMessage(session, focusMessage)) {
        return {
            round: null,
            reason: 'focus-is-assistant'
        }
    }

    const focusResult = await toCharacterTranscriptMessageResult(
        scope,
        session,
        focusMessage
    )
    if (focusResult.message == null) {
        return {
            round: null,
            reason: focusResult.reason
        }
    }

    const focusIndex = findLastCharacterMessageIndex(messages, focusMessage)
    const responseStartIndex = focusIndex >= 0 ? focusIndex + 1 : 0
    const lastAssistantIndex = findLastCharacterBotMessageIndex(
        session,
        messages,
        responseStartIndex
    )
    if (lastAssistantIndex < 0) {
        return {
            round: null,
            reason: 'assistant-response-missing'
        }
    }

    let firstResponseIndex = responseStartIndex
    if (focusIndex < 0) {
        firstResponseIndex = lastAssistantIndex
        while (
            firstResponseIndex > 0 &&
            isCharacterBotMessage(session, messages[firstResponseIndex - 1])
        ) {
            firstResponseIndex -= 1
        }
    }

    const responseMessages = await toCharacterTranscriptMessages(
        scope,
        session,
        messages
            .slice(firstResponseIndex, lastAssistantIndex + 1)
            .filter((message) => isCharacterBotMessage(session, message))
    )
    if (!responseMessages.some((message) => message.role === 'assistant')) {
        return {
            round: null,
            reason: 'assistant-response-missing'
        }
    }

    return {
        round: {
            messages: [focusResult.message, ...responseMessages]
        },
        reason: null
    }
}
