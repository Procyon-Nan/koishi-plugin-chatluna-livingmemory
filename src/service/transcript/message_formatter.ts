import type { LivingMemoryTranscriptMessage } from '../../contracts/memory'
import type {
    ExtractionPayload,
    MessageFormatter
} from '../../contracts/workflows'
import { serializeLivingMemorySourceMessages } from './source_serializer'
import { renderLivingMemoryTranscript } from './transcript_renderer'

export class LivingMemoryMessageFormatter implements MessageFormatter {
    toExtractionPayload(
        messages: LivingMemoryTranscriptMessage[]
    ): ExtractionPayload {
        const speakerByLabel = new Map<string, string>()
        for (const message of messages) {
            if (message.role !== 'user') {
                continue
            }
            if (message.speakerKey != null) {
                speakerByLabel.set(message.speakerLabel, message.speakerKey)
            }
        }
        return {
            input: renderLivingMemoryTranscript(messages),
            sourceOriginMessages: serializeLivingMemorySourceMessages(messages),
            speakers: [...speakerByLabel].map(([speakerLabel, speakerKey]) => ({
                speakerLabel,
                speakerKey
            }))
        }
    }
}
