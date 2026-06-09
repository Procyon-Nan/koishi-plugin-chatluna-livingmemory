import { LivingMemoryRepository } from '../repository'
import { formatDateOnly } from '../shared/utils'
import { scopeKey } from './helpers'
import type { MemoryScope, MemorySnapshotRecord } from '../../types'

export class LivingMemorySnapshotCache {
    private readonly snapshotVariableByScope = new Map<string, string>()

    constructor(private readonly repository: LivingMemoryRepository) {}

    clearByScope(scope: Pick<MemoryScope, 'presetId' | 'conversationId'>) {
        this.snapshotVariableByScope.delete(scopeKey(scope))
    }

    clearByPreset(presetId: string) {
        for (const key of this.snapshotVariableByScope.keys()) {
            if (key.startsWith(`${presetId}\n`)) {
                this.snapshotVariableByScope.delete(key)
            }
        }
    }

    clearByConversation(conversationId: string) {
        for (const key of this.snapshotVariableByScope.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.snapshotVariableByScope.delete(key)
            }
        }
    }

    async hydrate(scope: Pick<MemoryScope, 'presetId' | 'conversationId'>) {
        const snapshot = await this.repository.getLatestSnapshotByScope(scope)
        const rendered = await this.renderItems(snapshot?.items ?? [])
        this.snapshotVariableByScope.set(scopeKey(scope), rendered)
        return rendered
    }

    private async renderItems(items: MemorySnapshotRecord['items']) {
        if (items.length === 0) {
            return ''
        }

        const records = await this.repository.getEntriesByIds(
            items.map((item) => item.memoryId)
        )
        if (records.length === 0) {
            return ''
        }

        const ordered = items
            .map((item) =>
                records.find((record) => record.id === item.memoryId)
            )
            .filter(
                (record): record is NonNullable<typeof record> =>
                    record != null && record.status === 'active'
            )

        return ordered
            .map(
                (record) =>
                    `记录于 ${formatDateOnly(record.createdAt)}：${record.content}`
            )
            .join('\n')
    }
}
