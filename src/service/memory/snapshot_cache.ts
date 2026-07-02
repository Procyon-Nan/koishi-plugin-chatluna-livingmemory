import { LivingMemoryRepository } from '../repository'
import { formatDateOnly } from '../shared/utils'
import { scopeKey } from './helpers'
import {
    isAgenticMemorySnapshotItem,
    isMemoryReferenceItem
} from './snapshot_items'
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
        const rendered = await this.renderSnapshot(snapshot)
        this.snapshotVariableByScope.set(scopeKey(scope), rendered)
        return rendered
    }

    private async renderSnapshot(snapshot: MemorySnapshotRecord | undefined) {
        if (snapshot == null) {
            return ''
        }

        if (snapshot.strategy === 'agentic-tool-search') {
            return this.renderAgenticItems(snapshot.items)
        }

        return await this.renderReferenceItems(snapshot.items)
    }

    private renderAgenticItems(items: MemorySnapshotRecord['items']) {
        return items
            .filter(isAgenticMemorySnapshotItem)
            .map((item) => item.finalText.trim())
            .filter((text) => text.length > 0)
            .join('\n')
    }

    private async renderReferenceItems(items: MemorySnapshotRecord['items']) {
        const references = items.filter(isMemoryReferenceItem)
        if (references.length === 0) {
            return ''
        }

        const records = await this.repository.getEntriesByIds(
            references.map((item) => item.memoryId)
        )
        if (records.length === 0) {
            return ''
        }

        const ordered = references
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
