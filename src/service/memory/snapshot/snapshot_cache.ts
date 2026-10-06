import { scopeKey } from '../helpers'
import type {
    MemoryScope,
    MemorySnapshotRecord
} from '../../../contracts/memory'

interface SnapshotCacheRepository {
    getLatestSnapshotByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ): Promise<MemorySnapshotRecord | undefined>
}

export class LivingMemorySnapshotCache {
    private readonly snapshotVariableByScope = new Map<string, string>()

    constructor(private readonly repository: SnapshotCacheRepository) {}

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
        const rendered = this.renderSnapshot(snapshot)
        this.snapshotVariableByScope.set(scopeKey(scope), rendered)
        return rendered
    }

    private renderSnapshot(snapshot: MemorySnapshotRecord | undefined) {
        return (snapshot?.items ?? [])
            .map((item) => item.finalText.trim())
            .filter((text) => text.length > 0)
            .join('\n')
    }
}
