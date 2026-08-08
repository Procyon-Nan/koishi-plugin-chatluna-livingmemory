import type { LivingMemorySearchResult } from '../../../contracts/memory'
import type { RecallRepository } from '../../../contracts/workflows'

export const loadIndexedMemoryEntries = async (
    repository: RecallRepository,
    presetId: string,
    memoryIds: string[]
): Promise<LivingMemorySearchResult[]> => {
    const entries = await repository.getRecallEntriesByPresetAndIds(
        presetId,
        memoryIds
    )
    const entryById = new Map(entries.map((entry) => [entry.id, entry]))
    return memoryIds.map((memoryId) => {
        const entry = entryById.get(memoryId)
        if (entry === undefined) {
            throw new Error(
                `vector index result is missing from memory repository: ` +
                    `preset=${presetId}, memory=${memoryId}`
            )
        }
        return entry
    })
}
