import type {
    LivingMemoryTranscriptMessage,
    MemorySourceMessage
} from '../../contracts/memory'
import { renderLivingMemoryTranscriptLines } from './transcript_renderer'

export const serializeLivingMemorySourceMessage = (
    message: LivingMemoryTranscriptMessage
): MemorySourceMessage => {
    const transcriptLines = renderLivingMemoryTranscriptLines(message)

    return {
        role: message.role,
        speakerLabel: message.speakerLabel,
        contentLines: [...message.contentLines],
        createdAt: message.createdAt.toISOString(),
        transcriptLines,
        content:
            message.role === 'user'
                ? message.contentLines
                      .map((line) => `${message.speakerLabel}说：${line}`)
                      .join('\n')
                : message.contentLines.join('\n')
    }
}

export const serializeLivingMemorySourceMessages = (
    messages: LivingMemoryTranscriptMessage[]
) => {
    return messages.map(serializeLivingMemorySourceMessage)
}
