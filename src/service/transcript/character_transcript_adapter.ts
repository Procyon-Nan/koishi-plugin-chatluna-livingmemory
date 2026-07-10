import type { Session } from 'koishi'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../contracts/memory'
import { createLivingMemoryTranscriptMessageResult } from './transcript_message'

export interface CharacterTranscriptSourceMessage {
    content: string
    name?: string
    id?: string
    messageId?: string
    timestamp?: number
}

const toNonEmptyString = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined
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

    if (messageId != null && botIds.includes(messageId)) {
        return true
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
        return toNonEmptyString(scope.presetLabel) ?? scope.presetId
    }

    return resolveCharacterUserGlobalName(session, message, cache)
}

export const toCharacterTranscriptMessage = async (
    scope: MemoryScope,
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    return (await toCharacterTranscriptMessageResult(scope, session, message))
        .message
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
        speakerLabel,
        content: message.content,
        createdAt: message.timestamp,
        stripSpeakerPrefix: !isAssistant
    })
}

export const toCharacterTranscriptMessages = async (
    scope: MemoryScope,
    session: Session,
    messages: CharacterTranscriptSourceMessage[]
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

export const countCharacterCompletedRounds = (
    messages: LivingMemoryTranscriptMessage[]
) => {
    let count = 0
    let hasHuman = false
    let inAiBlock = false

    for (const message of messages) {
        if (message.role === 'user') {
            hasHuman = true
            inAiBlock = false
            continue
        }

        if (message.role === 'assistant' && hasHuman && !inAiBlock) {
            count += 1
            hasHuman = false
            inAiBlock = true
        }
    }

    return count
}
