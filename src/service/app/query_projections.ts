import type {
    LivingMemoryGetMessagesMemory,
    MemoryEntryRecord
} from '../../contracts/memory'
import { cloneSourceMessage } from '../memory/origins/source_origins'

export interface LivingMemoryQueryProjectionRepository {
    getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]>
}

export async function loadMemorySourceMessages(
    repository: LivingMemoryQueryProjectionRepository,
    presetId: string,
    memoryId: string
): Promise<LivingMemoryGetMessagesMemory | null> {
    const entries = await repository.getEntriesByPresetAndIds(presetId, [
        memoryId
    ])
    const entry = entries[0]
    if (entry == null) {
        return null
    }

    return {
        id: entry.id,
        sourceLabel: entry.sourceLabel,
        sourceOrigins: entry.sourceOrigins.map((origin) => ({
            messages: origin.messages.map(cloneSourceMessage)
        }))
    }
}
