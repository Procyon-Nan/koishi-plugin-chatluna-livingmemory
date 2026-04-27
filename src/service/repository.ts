import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    ExtractedMemoryItem,
    ExtractionRepository,
    JobRepository,
    MemoryEntryRecord,
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
                content: 'text',
                keywords: 'json',
                summary: 'text',
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
        return await this.ctx.database.get('living_memory_entry', {
            presetId
        })
    }

    async getEntryById(id: string): Promise<MemoryEntryRecord | undefined> {
        return (
            await this.ctx.database.get('living_memory_entry', {
                id
            })
        )[0]
    }

    async getEntriesByIds(ids: string[]): Promise<MemoryEntryRecord[]> {
        if (ids.length === 0) {
            return []
        }

        return await this.ctx.database.get('living_memory_entry', {
            id: {
                $in: ids
            }
        })
    }

    async getLatestSnapshotByPreset(presetId: string) {
        const snapshots = await this.ctx.database.get(
            'living_memory_snapshot',
            {
                presetId
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

    async createSnapshot(
        scope: MemoryScope,
        strategy: MemoryRecallStrategy,
        query: string,
        items: MemoryReference[]
    ) {
        const snapshot: MemorySnapshotRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            strategy,
            query,
            items,
            createdAt: new Date()
        }

        await this.ctx.database.create('living_memory_snapshot', snapshot)
    }

    async trimSnapshots(presetId: string, maxSnapshotsPerPreset: number) {
        const snapshots = await this.ctx.database.get(
            'living_memory_snapshot',
            {
                presetId
            }
        )

        if (snapshots.length <= maxSnapshotsPerPreset) {
            return
        }

        const staleSnapshots = snapshots
            .sort((left, right) => +right.createdAt - +left.createdAt)
            .slice(maxSnapshotsPerPreset)

        if (staleSnapshots.length === 0) {
            return
        }

        await this.ctx.database.remove('living_memory_snapshot', {
            id: {
                $in: staleSnapshots.map((snapshot) => snapshot.id)
            }
        })
    }

    async trimAllSnapshots(maxSnapshotsPerPreset: number) {
        const snapshots = await this.ctx.database.get(
            'living_memory_snapshot',
            {},
            ['presetId']
        )
        const presetIds = [...new Set(snapshots.map((s) => s.presetId))]
        for (const presetId of presetIds) {
            await this.trimSnapshots(presetId, maxSnapshotsPerPreset)
        }
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
                content: item.content,
                keywords: item.keywords?.length
                    ? item.keywords.slice(0, 12)
                    : defaultKeywords(item.content),
                summary: item.summary ?? null,
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
            content: input.content,
            keywords: input.keywords?.length
                ? input.keywords.slice(0, 12)
                : defaultKeywords(input.content),
            summary: input.summary ?? null,
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
                content,
                keywords: patch.keywords?.length
                    ? patch.keywords.slice(0, 12)
                    : patch.content != null
                      ? defaultKeywords(content)
                      : current.keywords,
                summary:
                    patch.summary === undefined
                        ? current.summary
                        : patch.summary,
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
