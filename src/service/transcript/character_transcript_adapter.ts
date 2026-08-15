import type { Session } from 'koishi'
import type {
    LivingMemoryCompletedRound,
    MemoryScope
} from '../../contracts/memory'
import { resolveScopeAssistantLabel } from '../memory/helpers'
import { toNonEmptyString } from '../shared/utils'
import { createLivingMemoryTranscriptMessageResult } from './transcript_message'

export interface CharacterTranscriptSourceMessage {
    content: string
    name?: string
    id?: string
    messageId?: string
    timestamp?: number
}

type CharacterGlobalNameCache = Map<string, Promise<string | undefined>>

const resolveCurrentSessionUserGlobalName = (session: Session) => {
    return (
        toNonEmptyString(session.event?.user?.nick) ??
        toNonEmptyString(session.event?.user?.name) ??
        toNonEmptyString(session.username)
    )
}

const isCurrentSessionUserMessage = (
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    const messageId = toNonEmptyString(message.id)
    const userId = toNonEmptyString(session.userId)

    return messageId != null && userId != null && messageId === userId
}

const resolveQueriedUserGlobalName = async (
    session: Session,
    userId: string,
    cache?: CharacterGlobalNameCache
) => {
    const cached = cache?.get(userId)
    if (cached != null) {
        return cached
    }

    const pending = session.bot
        .getUser(userId, session.guildId)
        .then((user) => {
            return (
                toNonEmptyString(user.nick) ??
                toNonEmptyString(user.name) ??
                toNonEmptyString(user.id)
            )
        })
    cache?.set(userId, pending)
    return pending
}

const resolveCharacterUserGlobalName = async (
    session: Session,
    message: CharacterTranscriptSourceMessage,
    cache?: CharacterGlobalNameCache
) => {
    const userId = toNonEmptyString(message.id)
    if (userId == null) {
        throw new Error(
            'Character user message has no id for global speaker lookup.'
        )
    }

    if (isCurrentSessionUserMessage(session, message)) {
        return (
            resolveCurrentSessionUserGlobalName(session) ??
            (await resolveQueriedUserGlobalName(session, userId, cache))
        )
    }

    return resolveQueriedUserGlobalName(session, userId, cache)
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

export const resolveCharacterScopeSpeakerName = async (
    session: Session,
    message?: CharacterTranscriptSourceMessage
) => {
    if (message != null && !isCharacterBotMessage(session, message)) {
        return resolveCharacterUserGlobalName(session, message)
    }

    const userId = toNonEmptyString(session.userId)
    if (userId != null) {
        return (
            resolveCurrentSessionUserGlobalName(session) ??
            (await resolveQueriedUserGlobalName(session, userId))
        )
    }

    return (
        toNonEmptyString(session.event?.user?.nick) ??
        toNonEmptyString(session.event?.user?.name) ??
        toNonEmptyString(session.username) ??
        toNonEmptyString(message?.id)
    )
}

const resolveCharacterSpeakerLabel = async (
    scope: MemoryScope,
    session: Session,
    message: CharacterTranscriptSourceMessage,
    cache?: CharacterGlobalNameCache
) => {
    if (isCharacterBotMessage(session, message)) {
        return resolveScopeAssistantLabel(scope)
    }

    return resolveCharacterUserGlobalName(session, message, cache)
}

export const toCharacterTranscriptMessageResult = async (
    scope: MemoryScope,
    session: Session,
    message: CharacterTranscriptSourceMessage,
    cache?: CharacterGlobalNameCache
) => {
    const isAssistant = isCharacterBotMessage(session, message)
    const speakerLabel = await resolveCharacterSpeakerLabel(
        scope,
        session,
        message,
        cache
    )

    return createLivingMemoryTranscriptMessageResult({
        role: isAssistant ? 'assistant' : 'user',
        speakerLabel: speakerLabel ?? '',
        content: message.content,
        createdAt: message.timestamp,
        stripSpeakerPrefix: !isAssistant
    })
}

export const toCharacterTranscriptMessages = async (
    scope: MemoryScope,
    session: Session,
    messages: readonly CharacterTranscriptSourceMessage[]
) => {
    const cache: CharacterGlobalNameCache = new Map()
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
