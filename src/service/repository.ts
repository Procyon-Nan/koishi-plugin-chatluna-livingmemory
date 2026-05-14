import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    ExtractedMemoryItem,
    ExtractionRepository,
    JobRepository,
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryJobKind,
    MemoryJobRecord,
    MemoryMutationInput,
    MemoryRecallStrategy,
    MemoryReference,
    MemoryScope,
    MemorySnapshotRecord,
    RecallRepository,
    SnapshotRepository
} from '../types'

const defaultKeywords = (content: string) => {
    return Array.from(
        new Set(
            content
                .toLowerCase()
                .split(/[^\p{L}\p{N}_]+/u)
                .map((part) => part.trim())
                .filter((part) => part.length >= 2)
        )
    ).slice(0, 12)
}

const normalizeSentiment = (sentiment: string | null | undefined) => {
    const normalized = sentiment?.trim()
    return normalized?.length ? normalized : null
}

const normalizeImportance = (
    importance: number | string | null | undefined
) => {
    const normalized =
        typeof importance === 'number'
            ? importance
            : typeof importance === 'string' && importance.trim().length > 0
              ? Number(importance.trim())
              : Number.NaN

    if (!Number.isFinite(normalized)) {
        return null
    }

    return Math.min(1, Math.max(0, normalized))
}

const normalizeStatus = (
    status: MemoryEntryStatus | string | null | undefined
): MemoryEntryStatus => {
    return status === 'archived' ? 'archived' : 'active'
}

const normalizeEntryRecord = (
    record: MemoryEntryRecord
): MemoryEntryRecord => ({
    ...record,
    status: normalizeStatus(record.status),
    sentiment: normalizeSentiment(record.sentiment),
    importance: normalizeImportance(record.importance)
})

export class LivingMemoryRepository
    implements
        RecallRepository,
        SnapshotRepository,
        JobRepository,
        ExtractionRepository
{
    constructor(private readonly ctx: Context) {}

    defineTables() {
        this.ctx.model.extend(
            'living_memory_entry',
            {
                id: 'string(64)',
                presetId: 'string(255)',
                type: 'string(32)',
                status: {
                    type: 'string',
                    length: 16,
                    initial: 'active'
                },
                content: 'text',
                keywords: 'json',
                summary: 'text',
                sentiment: {
                    type: 'text',
                    nullable: true,
                    initial: null
                },
                importance: {
                    type: 'double',
                    nullable: true,
                    initial: null
                },
                sourceConversationId: 'string(255)',
                sourceMessages: 'json',
                createdAt: 'timestamp',
                updatedAt: 'timestamp'
            },
            {
                autoInc: false,
                primary: 'id'
            }
        )

        this.ctx.model.extend(
            'living_memory_snapshot',
            {
                id: 'string(64)',
                presetId: 'string(255)',
                conversationId: 'string(255)',
                strategy: 'string(32)',
                query: 'text',
                items: 'json',
                createdAt: 'timestamp'
            },
            {
                autoInc: false,
                primary: 'id'
            }
        )

        this.ctx.model.extend(
            'living_memory_job',
            {
                id: 'string(64)',
                presetId: 'string(255)',
                conversationId: 'string(255)',
                kind: 'string(16)',
                status: 'string(16)',
                input: 'text',
                detail: 'text',
                error: 'text',
                createdAt: 'timestamp',
                startedAt: 'timestamp',
                finishedAt: 'timestamp',
                updatedAt: 'timestamp'
            },
            {
                autoInc: false,
                primary: 'id'
            }
        )
    }

    async listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]> {
        const entries = await this.ctx.database.get('living_memory_entry', {
            presetId
        })

        return entries.map(normalizeEntryRecord)
    }

    async getEntryById(id: string): Promise<MemoryEntryRecord | undefined> {
        const record = (
            await this.ctx.database.get('living_memory_entry', {
                id
            })
        )[0]

        return record == null ? undefined : normalizeEntryRecord(record)
    }

    async getEntriesByIds(ids: string[]): Promise<MemoryEntryRecord[]> {
        if (ids.length === 0) {
            return []
        }

        const entries = await this.ctx.database.get('living_memory_entry', {
            id: {
                $in: ids
            }
        })

        return entries.map(normalizeEntryRecord)
    }

    async getLatestSnapshotByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        const snapshots = await this.ctx.database.get(
            'living_memory_snapshot',
            {
                presetId: scope.presetId,
                conversationId: scope.conversationId
            }
        )

        return snapshots.sort(
            (left, right) => +right.createdAt - +left.createdAt
        )[0]
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
        items: MemoryReference[]
    ) {
        const createdAt = new Date()
        const existing = await this.ctx.database.get('living_memory_snapshot', {
            presetId: scope.presetId,
            conversationId: scope.conversationId
        })
        const sorted = existing.sort(
            (left, right) => +right.createdAt - +left.createdAt
        )
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
            presetId: snapshot.presetId,
            conversationId: snapshot.conversationId
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

    async createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string
    ): Promise<MemoryJobRecord> {
        const now = new Date()
        const job: MemoryJobRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            status: 'pending',
            input,
            detail: null,
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        }

        await this.ctx.database.create('living_memory_job', job)
        return job
    }

    async updateJob(
        id: string,
        patch: Partial<MemoryJobRecord>
    ): Promise<void> {
        await this.ctx.database.set('living_memory_job', { id }, patch)
    }

    async listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]> {
        const jobs = await this.ctx.database.get('living_memory_job', {
            presetId
        })

        return jobs.sort((left, right) => +right.createdAt - +left.createdAt)
    }

    async listRunningDreamJobsByPreset(
        presetId: string
    ): Promise<MemoryJobRecord[]> {
        const jobs = await this.ctx.database.get('living_memory_job', {
            presetId,
            kind: 'dream',
            status: 'running'
        })

        return jobs.sort((left, right) => +right.createdAt - +left.createdAt)
    }

    async appendMemories(
        scope: MemoryScope,
        sourceMessages: MemoryEntryRecord['sourceMessages'],
        extracted: ExtractedMemoryItem[]
    ) {
        if (extracted.length === 0) {
            return
        }

        const now = new Date()
        await this.ctx.database.upsert(
            'living_memory_entry',
            extracted.map((item) => ({
                id: randomUUID(),
                presetId: scope.presetId,
                type: item.type,
                status: normalizeStatus(item.status),
                content: item.content,
                keywords: item.keywords?.length
                    ? item.keywords.slice(0, 12)
                    : defaultKeywords(item.content),
                summary: item.summary ?? null,
                sentiment: normalizeSentiment(item.sentiment),
                importance: normalizeImportance(item.importance),
                sourceConversationId: scope.conversationId,
                sourceMessages,
                createdAt: now,
                updatedAt: now
            }))
        )
    }

    async createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        sourceMessages: MemoryEntryRecord['sourceMessages'] = []
    ) {
        const now = new Date()
        const record: MemoryEntryRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            type: input.type,
            status: normalizeStatus(input.status),
            content: input.content,
            keywords: input.keywords?.length
                ? input.keywords.slice(0, 12)
                : defaultKeywords(input.content),
            summary: input.summary ?? null,
            sentiment: normalizeSentiment(input.sentiment),
            importance: normalizeImportance(input.importance),
            sourceConversationId: scope.conversationId,
            sourceMessages,
            createdAt: now,
            updatedAt: now
        }

        await this.ctx.database.create('living_memory_entry', record)
        return record
    }

    async updateMemory(id: string, patch: Partial<MemoryMutationInput>) {
        const current = await this.getEntryById(id)
        if (current == null) {
            return
        }

        const content = patch.content ?? current.content
        await this.ctx.database.set(
            'living_memory_entry',
            { id },
            {
                type: patch.type ?? current.type,
                status:
                    patch.status === undefined
                        ? normalizeStatus(current.status)
                        : normalizeStatus(patch.status),
                content,
                keywords: patch.keywords?.length
                    ? patch.keywords.slice(0, 12)
                    : patch.content != null
                      ? defaultKeywords(content)
                      : current.keywords,
                summary:
                    patch.summary === undefined
                        ? (current.summary ?? null)
                        : patch.summary,
                sentiment:
                    patch.sentiment === undefined
                        ? normalizeSentiment(current.sentiment)
                        : normalizeSentiment(patch.sentiment),
                importance:
                    patch.importance === undefined
                        ? normalizeImportance(current.importance)
                        : normalizeImportance(patch.importance),
                updatedAt: new Date()
            }
        )
    }

    async deleteMemory(id: string) {
        await this.ctx.database.remove('living_memory_entry', { id })
    }

    async clearAllByPreset(presetId: string) {
        await Promise.all([
            this.ctx.database.remove('living_memory_entry', { presetId }),
            this.ctx.database.remove('living_memory_snapshot', { presetId }),
            this.ctx.database.remove('living_memory_job', { presetId })
        ])
    }

    async listDistinctPresetIds(): Promise<string[]> {
        const entries = await this.ctx.database.get('living_memory_entry', {}, [
            'presetId'
        ])
        return [...new Set(entries.map((e) => e.presetId))]
    }

    async removeExpiredJobs(deadline: Date) {
        await this.ctx.database.remove('living_memory_job', {
            updatedAt: {
                $lt: deadline
            }
        })
    }
}
