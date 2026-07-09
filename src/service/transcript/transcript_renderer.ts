import type { LivingMemoryTranscriptMessage } from '../../types'
import { formatLivingMemoryMessageTime } from './transcript_message'

export const renderLivingMemoryTranscriptLines = (
    message: LivingMemoryTranscriptMessage
) => {
    const time = formatLivingMemoryMessageTime(message.createdAt)
    return message.contentLines.map(
        (line) => `[${time}] ${message.speakerLabel}说：${line}`
    )
}

export const renderLivingMemoryTranscript = (
    messages: LivingMemoryTranscriptMessage[]
) => {
    return messages.flatMap(renderLivingMemoryTranscriptLines).join('\n')
}
