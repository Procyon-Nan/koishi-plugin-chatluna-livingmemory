import type { Session } from 'koishi'
import { toNonEmptyString } from '../shared/utils'

export interface CharacterTranscriptSourceMessage {
    content: string
    name: string
    id: string
    messageId?: string
    timestamp?: number
}

export const isCharacterBotMessage = (
    session: Session,
    message: CharacterTranscriptSourceMessage
) => {
    return message.id === session.selfId
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
