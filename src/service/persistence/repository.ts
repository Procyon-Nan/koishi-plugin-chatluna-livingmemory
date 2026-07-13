import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    MemoryEntryRecord,
    MemoryJobKind,
    MemoryJobRecord,
    MemoryMutationInput,
    MemoryRecallStrategy,
    MemoryScope,
    MemorySnapshotItem,
    MemorySnapshotRecord,
    MemorySourceMessage,
    PresetSpeakerInput,
    PresetSpeakerRecord,
    UserProfileInput,
    UserProfileRecord
} from '../../contracts/memory'
import type {
    DreamMergeInput,
    DreamMergeRepository,
    ExtractedMemoryItem,
    ExtractionRepository,
    JobRepository,
    RecallRepository,
    SnapshotRepository,
    UserProfileRepository
} from '../../contracts/workflows'
import {
    normalizeMemoryImportance,
    normalizeMemoryKeywords,
    normalizeMemoryStatus,
    normalizeMemoryText,
    normalizeOptionalMemoryText
} from '../memory/entry_fields'
import {
    createSourceOriginsFromMessages,
    normalizeMemorySourceOrigins
} from '../memory/origins/source_origins'
import {
    createPresetSpeakerId,
    normalizeEntryRecord,
    normalizeOptionalString,
    normalizePresetSpeakerRecord,
    normalizeUserProfileRecord
} from './normalizers'
import { defineLivingMemoryTables } from './tables'
import { summarizeError } from '../shared/utils'

const sourceOriginsArrayMigrationId = 'source-origins-array-v1'
const keywordFingerprintSeparator = '\u0000'

export class LivingMemoryRepository
    implements
        RecallRepository,
        SnapshotRepository,
        JobRepository,
        ExtractionRepository,
        DreamMergeRepository,
        UserProfileRepository
{
    constructor(private readonly ctx: Context) {}

    defineTables() {
        defineLivingMemoryTables(this.ctx)
    }

    async migrateMemorySourceOriginsArray(): Promise<number> {
        const applied = await this.ctx.database.get('living_memory_migration', {
            id: sourceOriginsArrayMigrationId
        })
        if (applied.length > 0) {
            return 0
        }

        const entries = await this.ctx.database.get('living_memory_entry', {}, [
            'id',
            'sourceOrigins'
        ])
        const invalidIds = entries
            .filter((entry) => !Array.isArray(entry.sourceOrigins))
            .map((entry) => entry.id)

        if (invalidIds.length > 0) {
            await this.ctx.database.set(
                'living_memory_entry',
                { id: { $in: invalidIds } },
                { sourceOrigins: [] }
            )
        }

        await this.ctx.database.create('living_memory_migration', {
            id: sourceOriginsArrayMigrationId,
            appliedAt: new Date()
        })
        return invalidIds.length
    }

    async listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]> {
        const entries = await this.ctx.database.get('living_memory_entry', {
            presetId
        })

        return entries.map(normalizeEntryRecord)
    }

    async countEntriesCreatedAfter(
        presetId: string,
        createdAfter?: Date
    ): Promise<number> {
        const query: Record<string, unknown> = { presetId }
        if (createdAfter != null) {
            query.createdAt = { $gt: createdAfter }
        }

        const entries = await this.ctx.database.get(
            'living_memory_entry',
            query,
            ['id']
        )
        return entries.length
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

    async getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]> {
        if (ids.length === 0) {
            return []
        }

        const entries = await this.ctx.database.get('living_memory_entry', {
            presetId,
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
        items: MemorySnapshotItem[]
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

    async createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        recallStrategy: MemoryRecallStrategy | null = null
    ): Promise<MemoryJobRecord> {
        const now = new Date()
        const job: MemoryJobRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            recallStrategy,
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

    async createFailedJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        error: unknown,
        startedAt: Date,
        recallStrategy: MemoryRecallStrategy | null = null
    ): Promise<MemoryJobRecord> {
        const finishedAt = new Date()
        const job: MemoryJobRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            recallStrategy,
            status: 'failed',
            input,
            detail: null,
            error: summarizeError(error),
            createdAt: startedAt,
            startedAt,
            finishedAt,
            updatedAt: finishedAt
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

    async getLatestJobByPresetAndKind(
        presetId: string,
        kind: MemoryJobKind
    ): Promise<MemoryJobRecord | undefined> {
        const jobs = await this.ctx.database.get('living_memory_job', {
            presetId,
            kind
        })

        return jobs.sort((left, right) => +right.createdAt - +left.createdAt)[0]
    }

    async markStaleRunningJobsAsFailed(
        options: { presetId?: string; kind?: MemoryJobKind } = {},
        reason = 'recovered: stale running job'
    ): Promise<MemoryJobRecord[]> {
        // 同时回收 pending 与 running：作业表为审计日志，不参与调度。
        // 若进程在 createJob（写入 pending）之后、markRunning 之前被终止，
        // 该行会永久卡在 pending，仅扫 running 无法清理，遗留幽灵审计记录。
        const query: Record<string, unknown> = {
            status: { $in: ['pending', 'running'] }
        }
        if (options.presetId != null) {
            query.presetId = options.presetId
        }
        if (options.kind != null) {
            query.kind = options.kind
        }

        const stale = await this.ctx.database.get('living_memory_job', query)
        if (stale.length === 0) {
            return []
        }

        const now = new Date()
        await this.ctx.database.set(
            'living_memory_job',
            { id: { $in: stale.map((job) => job.id) } },
            {
                status: 'failed',
                detail: reason,
                error: reason,
                finishedAt: now,
                updatedAt: now
            }
        )

        return stale
    }

    async appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: ExtractedMemoryItem[]
    ) {
        if (extracted.length === 0) {
            return
        }

        const now = new Date()
        const sourceOrigins =
            createSourceOriginsFromMessages(sourceOriginMessages)
        await this.ctx.database.upsert(
            'living_memory_entry',
            extracted.map((item) => ({
                id: randomUUID(),
                presetId: scope.presetId,
                type: item.type,
                status: normalizeMemoryStatus(item.status),
                content: normalizeMemoryText(item.content),
                keywords: normalizeMemoryKeywords(item.keywords),
                summary: normalizeOptionalMemoryText(item.summary),
                sentiment: normalizeOptionalMemoryText(item.sentiment),
                importance: normalizeMemoryImportance(item.importance),
                sourceConversationId: scope.conversationId,
                sourceOrigins,
                embedding: null,
                embeddingModelId: null,
                createdAt: now,
                updatedAt: now
            }))
        )
    }

    async createMemory(scope: MemoryScope, input: MemoryMutationInput) {
        const now = new Date()
        const record: MemoryEntryRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            type: input.type,
            status: normalizeMemoryStatus(input.status),
            content: normalizeMemoryText(input.content),
            keywords: normalizeMemoryKeywords(input.keywords),
            summary: normalizeOptionalMemoryText(input.summary),
            sentiment: normalizeOptionalMemoryText(input.sentiment),
            importance: normalizeMemoryImportance(input.importance),
            sourceConversationId: scope.conversationId,
            sourceOrigins: [],
            embedding: null,
            embeddingModelId: null,
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

        await this.ctx.database.set(
            'living_memory_entry',
            { id },
            {
                ...this.buildMemoryUpdatePatch(current, patch),
                updatedAt: new Date()
            }
        )
    }

    async applyDreamMerge(input: DreamMergeInput) {
        const sourceIds = input.sources.map((source) => source.id)
        const uniqueSourceIds = [...new Set(sourceIds)]
        if (
            uniqueSourceIds.length === 0 ||
            uniqueSourceIds.length !== sourceIds.length ||
            uniqueSourceIds.includes(input.target.id)
        ) {
            throw new Error('dream merge failed: invalid source ids')
        }

        const expectedStatus: MemoryEntryRecord['status'] =
            input.sourceDisposition === 'archive' ? 'active' : 'archived'
        if (input.patch.status !== expectedStatus) {
            throw new Error('dream merge failed: stage disposition mismatch')
        }

        await this.ctx.database.withTransaction(async (database) => {
            const entries = (
                await database.get('living_memory_entry', {
                    id: {
                        $in: [input.target.id, ...sourceIds]
                    }
                })
            ).map(normalizeEntryRecord)
            const entryById = new Map(entries.map((entry) => [entry.id, entry]))
            const target = entryById.get(input.target.id)
            const expectedSourceUpdatedAtById = new Map(
                input.sources.map((source) => [source.id, +source.updatedAt])
            )
            const sources = sourceIds
                .map((id) => entryById.get(id))
                .filter((entry): entry is MemoryEntryRecord => entry != null)

            if (
                target == null ||
                target.status !== expectedStatus ||
                +target.updatedAt !== +input.target.updatedAt ||
                sources.length !== sourceIds.length ||
                sources.some(
                    (source) =>
                        source.presetId !== target.presetId ||
                        source.status !== expectedStatus ||
                        +source.updatedAt !==
                            expectedSourceUpdatedAtById.get(source.id)
                )
            ) {
                throw new Error(
                    'dream merge failed: target or source memories changed'
                )
            }

            const updatedAt = new Date()
            const targetResult = await database.set(
                'living_memory_entry',
                {
                    id: target.id,
                    status: expectedStatus,
                    updatedAt: input.target.updatedAt
                },
                {
                    ...this.buildMemoryUpdatePatch(target, input.patch),
                    sourceOrigins: normalizeMemorySourceOrigins(
                        input.sourceOrigins
                    ),
                    updatedAt
                }
            )
            this.assertAffectedCount(targetResult.matched, 1, 'target update')

            const sourceQuery = {
                $or: input.sources.map((source) => ({
                    id: source.id,
                    status: expectedStatus,
                    updatedAt: source.updatedAt
                }))
            }
            if (input.sourceDisposition === 'archive') {
                const sourceResult = await database.set(
                    'living_memory_entry',
                    sourceQuery,
                    {
                        status: 'archived',
                        updatedAt
                    }
                )
                this.assertAffectedCount(
                    sourceResult.matched,
                    sourceIds.length,
                    'source archive'
                )
                return
            }

            const sourceResult = await database.remove(
                'living_memory_entry',
                sourceQuery
            )
            this.assertAffectedCount(
                sourceResult.removed ?? sourceResult.matched,
                sourceIds.length,
                'source delete'
            )
        })
    }

    private buildMemoryUpdatePatch(
        current: MemoryEntryRecord,
        patch: Partial<MemoryMutationInput>
    ) {
        const content =
            patch.content === undefined
                ? current.content
                : normalizeMemoryText(patch.content)
        const keywords =
            patch.keywords === undefined
                ? current.keywords
                : normalizeMemoryKeywords(patch.keywords)
        const summary =
            patch.summary === undefined
                ? (current.summary ?? null)
                : normalizeOptionalMemoryText(patch.summary)
        const status =
            patch.status === undefined
                ? normalizeMemoryStatus(current.status)
                : normalizeMemoryStatus(patch.status)
        const sentiment =
            patch.sentiment === undefined
                ? normalizeOptionalMemoryText(current.sentiment)
                : normalizeOptionalMemoryText(patch.sentiment)
        const importance =
            patch.importance === undefined
                ? normalizeMemoryImportance(current.importance)
                : normalizeMemoryImportance(patch.importance)
        // 内容/摘要/关键词变化时需要让已缓存的向量失效，由召回时按需重算
        const semanticChanged =
            content !== current.content ||
            summary !== (current.summary ?? null) ||
            keywords.join(keywordFingerprintSeparator) !==
                current.keywords.join(keywordFingerprintSeparator)

        return {
            type: patch.type ?? current.type,
            status,
            content,
            keywords,
            summary,
            sentiment,
            importance,
            ...(semanticChanged
                ? { embedding: null, embeddingModelId: null }
                : {})
        }
    }

    private assertAffectedCount(
        actual: number | undefined,
        expected: number,
        operation: string
    ) {
        if (actual != null && actual !== expected) {
            throw new Error(
                `dream merge failed: ${operation} affected ${actual} of ${expected} memories`
            )
        }
    }

    async updateEntryEmbeddings(
        updates: {
            id: string
            embedding: number[]
            embeddingModelId: string
        }[]
    ) {
        if (updates.length === 0) {
            return
        }

        await Promise.all(
            updates.map((update) =>
                this.ctx.database.set(
                    'living_memory_entry',
                    { id: update.id },
                    {
                        embedding: update.embedding,
                        embeddingModelId: update.embeddingModelId
                    }
                )
            )
        )
    }

    async deleteMemory(id: string) {
        await this.ctx.database.remove('living_memory_entry', { id })
    }

    async listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]> {
        const speakers = await this.ctx.database.get(
            'living_memory_preset_speaker',
            { presetId }
        )

        return speakers
            .map(normalizePresetSpeakerRecord)
            .filter(
                (speaker) =>
                    speaker.speakerKey.length > 0 &&
                    speaker.speakerLabel.length > 0
            )
            .sort((left, right) =>
                left.speakerLabel.localeCompare(right.speakerLabel)
            )
    }

    async upsertPresetSpeaker(input: PresetSpeakerInput) {
        const presetId = input.presetId.trim()
        const speakerKey = input.speakerKey.trim()
        const speakerLabel = input.speakerLabel.trim()
        if (
            presetId.length === 0 ||
            speakerKey.length === 0 ||
            speakerLabel.length === 0
        ) {
            return
        }

        const now = new Date()
        const id = createPresetSpeakerId(presetId, speakerKey)
        const record = {
            presetId,
            speakerKey,
            speakerLabel,
            speakerId: normalizeOptionalString(input.speakerId),
            updatedAt: now
        }
        const existing = (
            await this.ctx.database.get('living_memory_preset_speaker', { id })
        )[0]

        if (existing == null) {
            await this.ctx.database.create('living_memory_preset_speaker', {
                ...record,
                id,
                createdAt: now
            })
            return
        }

        await this.ctx.database.set(
            'living_memory_preset_speaker',
            { id },
            record
        )
    }

    async listUserProfilesByPreset(
        presetId: string
    ): Promise<UserProfileRecord[]> {
        const profiles = await this.ctx.database.get(
            'living_memory_user_profile',
            { presetId }
        )

        return profiles
            .map(normalizeUserProfileRecord)
            .sort((left, right) =>
                left.speakerLabel.localeCompare(right.speakerLabel)
            )
    }

    async listUserProfilesBySpeakerKeys(
        presetId: string,
        speakerKeys: string[]
    ): Promise<UserProfileRecord[]> {
        const keys = [...new Set(speakerKeys)].filter((key) => key.length > 0)
        if (keys.length === 0) {
            return []
        }

        const profiles = await this.ctx.database.get(
            'living_memory_user_profile',
            {
                presetId,
                speakerKey: {
                    $in: keys
                }
            }
        )

        return profiles.map(normalizeUserProfileRecord)
    }

    async replaceUserProfile(presetId: string, profile: UserProfileInput) {
        const existing = (
            await this.ctx.database.get('living_memory_user_profile', {
                presetId,
                speakerKey: profile.speakerKey
            })
        )
            .map(normalizeUserProfileRecord)
            .sort((left, right) => +left.createdAt - +right.createdAt)
        const current = existing[0]
        const now = new Date()
        const record = {
            presetId,
            speakerKey: profile.speakerKey,
            speakerLabel: profile.speakerLabel,
            content: profile.content,
            sourceMemoryIds: profile.sourceMemoryIds,
            updatedAt: now
        }

        if (current == null) {
            await this.ctx.database.create('living_memory_user_profile', {
                ...record,
                id: randomUUID(),
                createdAt: now
            })
            return
        }

        await this.ctx.database.set(
            'living_memory_user_profile',
            { id: current.id },
            record
        )

        const staleIds = existing.slice(1).map((profile) => profile.id)
        if (staleIds.length > 0) {
            await this.ctx.database.remove('living_memory_user_profile', {
                id: {
                    $in: staleIds
                }
            })
        }
    }

    async deleteUserProfile(profileId: string) {
        await this.ctx.database.remove('living_memory_user_profile', {
            id: profileId
        })
    }

    async clearAllByPreset(presetId: string) {
        await Promise.all([
            this.ctx.database.remove('living_memory_entry', { presetId }),
            this.ctx.database.remove('living_memory_snapshot', { presetId }),
            this.ctx.database.remove('living_memory_job', { presetId }),
            this.ctx.database.remove('living_memory_user_profile', {
                presetId
            }),
            this.ctx.database.remove('living_memory_preset_speaker', {
                presetId
            })
        ])
    }

    async listDistinctPresetIds(): Promise<string[]> {
        const [entries, snapshots, jobs, profiles, speakers] =
            await Promise.all([
                this.ctx.database.get('living_memory_entry', {}, ['presetId']),
                this.ctx.database.get('living_memory_snapshot', {}, [
                    'presetId'
                ]),
                this.ctx.database.get('living_memory_job', {}, ['presetId']),
                this.ctx.database.get('living_memory_user_profile', {}, [
                    'presetId'
                ]),
                this.ctx.database.get('living_memory_preset_speaker', {}, [
                    'presetId'
                ])
            ])

        return [
            ...new Set(
                [...entries, ...snapshots, ...jobs, ...profiles, ...speakers]
                    .map((record) => record.presetId)
                    .filter((presetId) => presetId.length > 0)
            )
        ]
    }

    async removeExpiredJobs(deadline: Date) {
        await this.ctx.database.remove('living_memory_job', {
            updatedAt: {
                $lt: deadline
            }
        })
    }
}
