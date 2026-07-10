import type { LivingMemoryTranscriptMessage } from '../../contracts/memory'
import type {
    ExtractionPayload,
    MessageFormatter
} from '../../contracts/workflows'
import { serializeLivingMemorySourceMessages } from './source_serializer'
import { takeRecentRounds } from '../shared/rounds'
import { renderLivingMemoryTranscript } from './transcript_renderer'

export class LivingMemoryMessageFormatter implements MessageFormatter {
    takeRecentRounds(
        messages: LivingMemoryTranscriptMessage[],
        roundCount: number
    ) {
        return takeRecentRounds(messages, roundCount, 'pair')
    }

    toExtractionPayload(
        messages: LivingMemoryTranscriptMessage[]
    ): ExtractionPayload {
        return {
            input: renderLivingMemoryTranscript(messages),
            sourceOriginMessages: serializeLivingMemorySourceMessages(messages)
        }
    }
}
