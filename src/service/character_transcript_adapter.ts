import type { Session } from 'koishi'
import type { LivingMemoryTranscriptMessage, MemoryScope } from '../types'
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

const resolveCurrentUserStableName = (session: Session) => {
    return (
        toNonEmptyString(session.event?.user?.nick) ??
        toNonEmptyString(session.event?.user?.name) ??
        toNonEmptyString(session.author?.username) ??
        toNonEmptyString(session.username) ??
        toNonEmptyString(session.author?.nick) ??
        toNonEmptyString(session.author?.name) ??
        toNonEmptyString(session.userId)
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

const resolveCharacterMessageName = (
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    const displayName = toNonEmptyString(message.name)
    const stableName = isCurrentSessionUserMessage(session, message)
        ? resolveCurrentUserStableName(session)
        : undefined

    return {
        name: stableName ?? displayName,
        displayName,
        stableName
    }
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

export const resolveCharacterScopeSpeakerName = (
    session: Session,
    message?: CharacterTranscriptSourceMessage
) => {
    if (message != null && isCurrentSessionUserMessage(session, message)) {
        return resolveCurrentUserStableName(session)
    }

    return (
        toNonEmptyString(session.event?.user?.nick) ??
        toNonEmptyString(session.event?.user?.name) ??
        toNonEmptyString(session.author?.username) ??
        toNonEmptyString(session.username) ??
        toNonEmptyString(session.author?.nick) ??
        toNonEmptyString(session.author?.name) ??
        toNonEmptyString(message?.name) ??
        toNonEmptyString(message?.id) ??
        toNonEmptyString(session.userId)
    )
}

const resolveCharacterSpeakerLabel = (
    scope: MemoryScope,
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    if (isCharacterBotMessage(session, message)) {
        return toNonEmptyString(scope.presetLabel) ?? scope.presetId
    }

    const nameInfo = resolveCharacterMessageName(session, message)
    return (
        nameInfo.name ??
        nameInfo.displayName ??
        toNonEmptyString(message.id) ??
        toNonEmptyString(scope.speakerName) ??
        '用户'
    )
}

export const toCharacterTranscriptMessage = (
    scope: MemoryScope,
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    return toCharacterTranscriptMessageResult(scope, session, message).message
}

export const toCharacterTranscriptMessageResult = (
    scope: MemoryScope,
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    const isAssistant = isCharacterBotMessage(session, message)

    return createLivingMemoryTranscriptMessageResult({
        role: isAssistant ? 'assistant' : 'user',
        speakerLabel: resolveCharacterSpeakerLabel(scope, session, message),
        content: message.content,
        createdAt: message.timestamp,
        stripSpeakerPrefix: !isAssistant
    })
}

export const toCharacterTranscriptMessages = (
    scope: MemoryScope,
    session: Session,
    messages: CharacterTranscriptSourceMessage[]
) => {
    return messages
        .map((message) =>
            toCharacterTranscriptMessageResult(scope, session, message)
        )
        .flatMap((converted) =>
            converted.message == null ? [] : [converted.message]
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
