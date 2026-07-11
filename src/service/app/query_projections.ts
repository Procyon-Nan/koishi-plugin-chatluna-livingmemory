import type {
    LivingMemoryGetMessagesOutput,
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
    memoryIds: string[]
): Promise<LivingMemoryGetMessagesOutput> {
    const orderedIds = [...new Set(memoryIds)]
    const entries = await repository.getEntriesByPresetAndIds(
        presetId,
        orderedIds
    )
    const entryById = new Map(entries.map((entry) => [entry.id, entry]))

    return {
        memories: orderedIds.flatMap((id) => {
            const entry = entryById.get(id)
            if (entry == null) {
                return []
            }

            return [
                {
                    id: entry.id,
                    type: entry.type,
                    content: entry.content,
                    keywords: [...entry.keywords],
                    summary: entry.summary,
                    importance: entry.importance,
                    createdAt: entry.createdAt.toISOString(),
                    updatedAt: entry.updatedAt.toISOString(),
                    sourceOrigins: entry.sourceOrigins.map(
                        (origin, originIndex) => ({
                            originIndex,
                            messages: origin.messages.map(cloneSourceMessage)
                        })
                    )
                }
            ]
        }),
        notFoundMemoryIds: orderedIds.filter((id) => !entryById.has(id))
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
