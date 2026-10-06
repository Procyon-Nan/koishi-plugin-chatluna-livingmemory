import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    AgenticMemorySnapshotItem,
    MemoryScope,
    MemorySnapshotRecord
} from '../../contracts/memory'
import type { SnapshotRepository } from '../../contracts/workflows'
import type { LivingMemoryTransact } from './types'

const legacyReferenceSnapshotMigrationId =
    'legacy-reference-snapshot-cleanup-v1'

export class LivingMemorySnapshotRepository implements SnapshotRepository {
    constructor(
        private readonly ctx: Context,
        private readonly transact: LivingMemoryTransact
    ) {}

    /**
     * 已移除的 embedding-rerank 策略只存记忆 id 引用、不带 finalText；
     * 策略列已不在模型中，只能按快照项形状识别并删除，交给后续召回重建。
     */
    async removeLegacyReferenceSnapshots(): Promise<number> {
        return await this.transact(async (database) => {
            const applied = await database.get('living_memory_migration', {
                id: legacyReferenceSnapshotMigrationId
            })
            if (applied.length > 0) {
                return 0
            }

            const snapshots = await database.get('living_memory_snapshot', {}, [
                'id',
                'items'
            ])
            const legacyIds = snapshots
                .filter((snapshot) =>
                    snapshot.items.some((item) => !('finalText' in item))
                )
                .map((snapshot) => snapshot.id)

            if (legacyIds.length > 0) {
                await database.remove('living_memory_snapshot', {
                    id: { $in: legacyIds }
                })
            }

            await database.create('living_memory_migration', {
                id: legacyReferenceSnapshotMigrationId,
                appliedAt: new Date()
            })
            return legacyIds.length
        })
    }

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
        query: string,
        items: AgenticMemorySnapshotItem[]
    ) {
        const createdAt = new Date()
        const sorted = await this.loadSortedSnapshotsByScope(scope)
        const latest = sorted[0]

        if (latest != null) {
            await this.ctx.database.set(
                'living_memory_snapshot',
                { id: latest.id },
                {
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

    async deleteSnapshotsByPreset(presetId: string) {
        await this.ctx.database.remove('living_memory_snapshot', { presetId })
    }
}
