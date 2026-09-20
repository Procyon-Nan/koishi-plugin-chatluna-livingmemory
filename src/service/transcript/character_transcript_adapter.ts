import type { Session } from 'koishi'
import type { MemoryScope } from '../../contracts/memory'
import { resolveScopeAssistantLabel } from '../memory/helpers'
import { toNonEmptyString } from '../shared/utils'
import { createLivingMemoryTranscriptMessageResult } from './transcript_message'
import { resolveUserSpeaker, type UserSpeakerCache } from './user_speaker'

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
