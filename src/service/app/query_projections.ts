import type {
    LivingMemoryGetMessagesMemory,
    MemoryEntryRecord,
    MemorySnapshotRecord,
    MemorySnapshotWithResolvedItems
} from '../../contracts/memory'
import type { PageResult, SnapshotListQuery } from '../../contracts/rpc'
import { filterSnapshotList } from '../../query'
import { cloneSourceMessage } from '../memory/origins/source_origins'
import { isMemoryReferenceItem } from '../memory/snapshot/snapshot_items'

export interface LivingMemoryQueryProjectionRepository {
    getEntriesByIds(ids: string[]): Promise<MemoryEntryRecord[]>
    getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]>
    listSnapshotsByPreset(presetId: string): Promise<MemorySnapshotRecord[]>
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

export async function listResolvedMemorySnapshots(
    repository: LivingMemoryQueryProjectionRepository,
    query: SnapshotListQuery
): Promise<PageResult<MemorySnapshotWithResolvedItems>> {
    const items = await repository.listSnapshotsByPreset(query.presetId)
    const page = filterSnapshotList(items, query)
    const memoryIds = [
        ...new Set(
            page.items.flatMap((snapshot) =>
                snapshot.items.flatMap((item) =>
                    isMemoryReferenceItem(item) ? [item.memoryId] : []
                )
            )
        )
    ]
    const records = await repository.getEntriesByIds(memoryIds)
    const recordById = new Map(records.map((record) => [record.id, record]))

    return {
        ...page,
        items: page.items.map((snapshot) => ({
            ...snapshot,
            resolvedItems: snapshot.items
                .filter(isMemoryReferenceItem)
                .map((item) => {
                    const memory = recordById.get(item.memoryId) ?? null
                    return {
                        ...item,
                        memory,
                        missing: memory == null
                    }
                })
        }))
    }
}
