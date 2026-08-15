import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    MemoryRecallStrategy,
    MemoryScope,
    MemorySnapshotItem,
    MemorySnapshotRecord
} from '../../contracts/memory'
import type { SnapshotRepository } from '../../contracts/workflows'

export class LivingMemorySnapshotRepository implements SnapshotRepository {
    constructor(private readonly ctx: Context) {}

    async getLatestSnapshotByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        const sorted = await this.loadSortedSnapshotsByScope(scope)
        return sorted[0]
    }

    async listSnapshotsByPreset(
        presetId: string
    ): Promise<MemorySnapshotRecord[]> {
        const snapshots = await this.ctx.database.get(
            'living_memory_snapshot',
            {
                presetId
            }
        )

        return snapshots.sort(
            (left, right) => +right.createdAt - +left.createdAt
        )
    }

    async upsertSnapshot(
        scope: MemoryScope,
        strategy: MemoryRecallStrategy,
        query: string,
        items: MemorySnapshotItem[]
    ) {
        const createdAt = new Date()
        const sorted = await this.loadSortedSnapshotsByScope(scope)
        const latest = sorted[0]

        if (latest != null) {
            await this.ctx.database.set(
                'living_memory_snapshot',
                { id: latest.id },
                {
                    strategy,
                    query,
                    items,
                    createdAt
                }
            )

            const staleIds = sorted.slice(1).map((snapshot) => snapshot.id)
            if (staleIds.length > 0) {
                await this.ctx.database.remove('living_memory_snapshot', {
                    id: {
                        $in: staleIds
                    }
                })
            }

            return
        }

        const snapshot: MemorySnapshotRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            strategy,
            query,
            items,
            createdAt
        }

        await this.ctx.database.create('living_memory_snapshot', snapshot)
    }

    private async loadSortedSnapshotsByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ): Promise<MemorySnapshotRecord[]> {
        const snapshots = await this.ctx.database.get(
            'living_memory_snapshot',
            {
                presetId: scope.presetId,
                conversationId: scope.conversationId
            }
        )

        return snapshots.sort(
            (left, right) => +right.createdAt - +left.createdAt
        )
    }

    async deleteSnapshot(
        snapshotId: string
    ): Promise<MemorySnapshotRecord | undefined> {
        const snapshot = (
            await this.ctx.database.get('living_memory_snapshot', {
                id: snapshotId
            })
        )[0]

        if (snapshot == null) {
            return undefined
        }

        await this.ctx.database.remove('living_memory_snapshot', {
            id: snapshotId
        })

        return snapshot
    }

    async deleteSnapshotsByConversation(
        conversationId: string
    ): Promise<MemorySnapshotRecord[]> {
        const snapshots = await this.ctx.database.get(
            'living_memory_snapshot',
            {
                conversationId
            }
        )

        if (snapshots.length === 0) {
            return []
        }

        await this.ctx.database.remove('living_memory_snapshot', {
            id: {
                $in: snapshots.map((snapshot) => snapshot.id)
            }
        })

        return snapshots
    }
}
