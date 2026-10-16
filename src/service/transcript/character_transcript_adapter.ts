import type { Session } from 'koishi'
import { toNonEmptyString } from '../shared/utils'

export interface CharacterTranscriptSourceMessage {
    content: string
    name?: string
    id?: string
    messageId?: string
    timestamp?: number
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
    right: CharacterTranscriptSourceMessage
) => {
    const leftMessageId = toNonEmptyString(left.messageId)
    const rightMessageId = toNonEmptyString(right.messageId)
    if (leftMessageId != null && rightMessageId != null) {
        return leftMessageId === rightMessageId && left.id === right.id
    }

    return (
        left.id === right.id &&
        left.timestamp === right.timestamp &&
        left.content === right.content
    )
}
