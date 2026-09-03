import { Context } from 'koishi'
import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetExportEntry,
    LivingMemoryPresetImportSummary,
    MemoryEntryRecord,
    MemoryJobKind,
    MemoryJobRecord,
    MemoryMutationInput,
    MemoryRecallStrategy,
    MemoryScope,
    MemorySnapshotItem,
    MemorySnapshotRecord,
    MemorySourceMessage,
    MemoryUpdatePatch,
    PresetSpeakerInput,
    PresetSpeakerRecord,
    UserProfileInput,
    UserProfileRecord
} from '../../contracts/memory'
import type {
    LegacyMemoryEmbeddingRecord,
    MemoryIndexSourceRecord
} from '../../contracts/vector_index'
import type {
    AttributedMemoryItem,
    DreamMemoryEntryRecord,
    DreamMergeInput,
    DreamMemoryMutation,
    ExtractionRepository,
    JobRepository,
    RecallRepository,
    SnapshotRepository,
    UserProfileMemoryRepository,
    UserProfileRepository
} from '../../contracts/workflows'
import { LivingMemoryEntryRepository } from './entries'
import { LivingMemoryJobRepository } from './jobs'
import {
    createActiveMemorySpeakerRows,
    createPresetImportId,
    createPresetSpeakerId
} from './normalizers'
import { LivingMemorySnapshotRepository } from './snapshots'
import { defineLivingMemoryTables } from './tables'
import { LivingMemoryUserProfileRepository } from './user_profiles'
import {
    reconcilePresetSpeaker,
    resolvePresetSpeakerIdentity
} from './speaker_reconciliation'
import type { LivingMemoryTransaction } from './types'
import { SerialTaskQueue } from '../shared/serial_task_queue'

const PRESET_IMPORT_BATCH_SIZE = 100
const TRANSACTION_QUEUE_KEY = 'living-memory-transaction'

const runPresetImportBatches = async <T>(
    stage: string,
    records: readonly T[],
    applyBatch: (batch: T[]) => Promise<unknown>
) => {
    const totalBatches = Math.ceil(records.length / PRESET_IMPORT_BATCH_SIZE)

    for (
        let offset = 0;
        offset < records.length;
        offset += PRESET_IMPORT_BATCH_SIZE
    ) {
        const batch = records.slice(offset, offset + PRESET_IMPORT_BATCH_SIZE)
        const batchNumber = Math.floor(offset / PRESET_IMPORT_BATCH_SIZE) + 1

        try {
            await applyBatch(batch)
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error)
            throw new Error(
                `preset import failed during ${stage} batch ` +
                    `${batchNumber}/${totalBatches} ` +
                    `(records ${offset + 1}-${offset + batch.length}): ${detail}`,
                { cause: error }
            )
        }
    }
}

export class LivingMemoryRepository
    implements
        RecallRepository,
        SnapshotRepository,
        JobRepository,
        ExtractionRepository,
        UserProfileMemoryRepository,
        UserProfileRepository
{
    private readonly entries: LivingMemoryEntryRepository
    private readonly jobs: LivingMemoryJobRepository
    private readonly snapshots: LivingMemorySnapshotRepository
    private readonly userProfiles: LivingMemoryUserProfileRepository
    private readonly transactions = new SerialTaskQueue()

    constructor(private readonly ctx: Context) {
        this.entries = new LivingMemoryEntryRepository(ctx, (callback) =>
            this.runTransaction(callback)
        )
        this.jobs = new LivingMemoryJobRepository(ctx)
        this.snapshots = new LivingMemorySnapshotRepository(ctx)
        this.userProfiles = new LivingMemoryUserProfileRepository(
            ctx,
            (callback) => this.runTransaction(callback)
        )
    }

    defineTables() {
        defineLivingMemoryTables(this.ctx)
    }

    /**
     * 全部事务的唯一入口。单连接数据库无法并发开启事务，因此所有事务共用一条
     * 串行链；这是驱动限制的变通，不是一致性机制本身——一致性来自事务边界，
     * 上层的预设级串行队列不得因此被移除。
     */
    private runTransaction<T>(
        callback: (database: LivingMemoryTransaction) => Promise<T>
    ) {
        return this.transactions.run(TRANSACTION_QUEUE_KEY, () =>
            this.ctx.database.transact(callback)
        )
    }

    migrateMemorySourceOriginsArray(): Promise<number> {
        return this.entries.migrateMemorySourceOriginsArray()
    }

    migrateActiveMemorySpeakers(): Promise<number> {
        return this.entries.migrateActiveMemorySpeakers()
    }

    hasMigratedLegacyEmbeddings(): Promise<boolean> {
        return this.entries.hasMigratedLegacyEmbeddings()
    }

    completeLegacyEmbeddingMigration(): Promise<void> {
        return this.entries.completeLegacyEmbeddingMigration()
    }

    listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]> {
        return this.entries.listEntriesByPreset(presetId)
    }

    listArchivedEntriesBefore(presetId: string, updatedBefore: Date) {
        return this.entries.listArchivedEntriesBefore(presetId, updatedBefore)
    }

    listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]> {
        return this.entries.listDreamEntriesByPreset(presetId)
    }

    listActiveMemorySpeakerKeys(presetId: string): Promise<string[]> {
        return this.entries.listActiveMemorySpeakerKeys(presetId)
    }

    listActiveMemorySpeakerLinks(presetId: string, speakerKeys: string[]) {
        return this.entries.listActiveMemorySpeakerLinks(presetId, speakerKeys)
    }

    listEntryIndexSourcePage(
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        return this.entries.listEntryIndexSourcePage(afterId, limit)
    }

    listEntryIndexSourcePageByPreset(
        presetId: string,
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        return this.entries.listEntryIndexSourcePageByPreset(
            presetId,
            afterId,
            limit
        )
    }

    listLegacyEmbeddingPage(
        afterId: string | null,
        limit: number
    ): Promise<LegacyMemoryEmbeddingRecord[]> {
        return this.entries.listLegacyEmbeddingPage(afterId, limit)
    }

    countEntriesByPreset(presetId: string): Promise<number> {
        return this.entries.countEntriesByPreset(presetId)
    }

    countEntries(): Promise<number> {
        return this.entries.countEntries()
    }

    listEntryPresetIds(): Promise<string[]> {
        return this.entries.listEntryPresetIds()
    }

    countActiveEntries(presetId: string): Promise<number> {
        return this.entries.countActiveEntries(presetId)
    }

    countPendingEntries(presetId: string): Promise<number> {
        return this.entries.countPendingEntries(presetId)
    }

    listPendingEntries(
        presetId: string,
        limit: number
    ): Promise<MemoryEntryRecord[]> {
        return this.entries.listPendingEntries(presetId, limit)
    }

    getEntryById(id: string): Promise<MemoryEntryRecord | undefined> {
        return this.entries.getEntryById(id)
    }

    getEntriesByIds(ids: string[]): Promise<MemoryEntryRecord[]> {
        return this.entries.getEntriesByIds(ids)
    }

    getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]> {
        return this.entries.getEntriesByPresetAndIds(presetId, ids)
    }

    getRecallEntriesByPresetAndIds(presetId: string, ids: string[]) {
        return this.entries.getRecallEntriesByPresetAndIds(presetId, ids)
    }

    appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: AttributedMemoryItem[]
    ): Promise<MemoryEntryRecord[]> {
        return this.entries.appendMemories(
            scope,
            sourceOriginMessages,
            extracted
        )
    }

    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys?: string[]
    ): Promise<MemoryEntryRecord> {
        return this.entries.createMemory(scope, input, speakerKeys)
    }

    updateMemory(id: string, patch: MemoryUpdatePatch) {
        return this.entries.updateMemory(id, patch)
    }

    updateMemoryForDream(
        id: string,
        patch: DreamMemoryMutation | { status: 'archived' },
        isConsolidated?: boolean
    ) {
        return this.entries.updateMemoryForDream(id, patch, isConsolidated)
    }

    setMemoryConsolidation(
        presetId: string,
        ids: string[],
        isConsolidated: boolean
    ) {
        return this.entries.setMemoryConsolidation(
            presetId,
            ids,
            isConsolidated
        )
    }

    archiveActiveEntries(presetId: string, ids: string[]) {
        return this.entries.archiveActiveEntries(presetId, ids)
    }

    applyDreamMerge(input: DreamMergeInput) {
        return this.entries.applyDreamMerge(input)
    }

    deleteMemory(id: string) {
        return this.entries.deleteMemory(id)
    }

    deleteEntries(presetId: string, ids: string[]) {
        return this.entries.deleteEntries(presetId, ids)
    }

    getLatestSnapshotByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ): Promise<MemorySnapshotRecord | undefined> {
        return this.snapshots.getLatestSnapshotByScope(scope)
    }

    listSnapshotsByPreset(presetId: string): Promise<MemorySnapshotRecord[]> {
        return this.snapshots.listSnapshotsByPreset(presetId)
    }

    upsertSnapshot(
        scope: MemoryScope,
        strategy: MemoryRecallStrategy,
        query: string,
        items: MemorySnapshotItem[]
    ): Promise<void> {
        return this.snapshots.upsertSnapshot(scope, strategy, query, items)
    }

    deleteSnapshot(
        snapshotId: string
    ): Promise<MemorySnapshotRecord | undefined> {
        return this.snapshots.deleteSnapshot(snapshotId)
    }

    deleteSnapshotsByConversation(
        conversationId: string
    ): Promise<MemorySnapshotRecord[]> {
        return this.snapshots.deleteSnapshotsByConversation(conversationId)
    }

    deleteSnapshotsByPreset(presetId: string) {
        return this.snapshots.deleteSnapshotsByPreset(presetId)
    }

    createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        recallStrategy: MemoryRecallStrategy | null = null
    ): Promise<MemoryJobRecord> {
        return this.jobs.createJob(scope, kind, input, recallStrategy)
    }

    createFailedJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        error: unknown,
        startedAt: Date,
        recallStrategy: MemoryRecallStrategy | null = null
    ): Promise<MemoryJobRecord> {
        return this.jobs.createFailedJob(
            scope,
            kind,
            input,
            error,
            startedAt,
            recallStrategy
        )
    }

    updateJob(id: string, patch: Partial<MemoryJobRecord>): Promise<void> {
        return this.jobs.updateJob(id, patch)
    }

    listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]> {
        return this.jobs.listJobsByPreset(presetId)
    }

    markStaleRunningJobsAsFailed(
        options: { presetId?: string; kind?: MemoryJobKind } = {},
        reason = 'recovered: stale running job'
    ): Promise<MemoryJobRecord[]> {
        return this.jobs.markStaleRunningJobsAsFailed(options, reason)
    }

    removeExpiredJobs(deadline: Date): Promise<void> {
        return this.jobs.removeExpiredJobs(deadline)
    }

    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]> {
        return this.userProfiles.listPresetSpeakers(presetId)
    }

    upsertPresetSpeaker(input: PresetSpeakerInput): Promise<void> {
        return this.userProfiles.upsertPresetSpeaker(input)
    }

    async reconcilePresetSpeaker(input: PresetSpeakerInput): Promise<void> {
        const identity = resolvePresetSpeakerIdentity(input)
        if (identity == null) {
            return
        }
        await this.runTransaction((database) =>
            reconcilePresetSpeaker(database, identity)
        )
    }

    listUserProfilesByPreset(presetId: string): Promise<UserProfileRecord[]> {
        return this.userProfiles.listUserProfilesByPreset(presetId)
    }

    listUserProfilesBySpeakerKeys(
        presetId: string,
        speakerKeys: string[]
    ): Promise<UserProfileRecord[]> {
        return this.userProfiles.listUserProfilesBySpeakerKeys(
            presetId,
            speakerKeys
        )
    }

    replaceUserProfile(
        presetId: string,
        profile: UserProfileInput
    ): Promise<void> {
        return this.userProfiles.replaceUserProfile(presetId, profile)
    }

    updateUserProfileContent(
        profileId: string,
        content: string
    ): Promise<void> {
        return this.userProfiles.updateUserProfileContent(profileId, content)
    }

    deleteUserProfile(profileId: string): Promise<void> {
        return this.userProfiles.deleteUserProfile(profileId)
    }

    async clearAllByPreset(presetId: string) {
        await this.runTransaction(async (database) => {
            await database.remove('living_memory_entry', { presetId })
            await database.remove('living_memory_entry_speaker', { presetId })
            await database.remove('living_memory_snapshot', { presetId })
            await database.remove('living_memory_job', { presetId })
            await database.remove('living_memory_user_profile', { presetId })
            await database.remove('living_memory_preset_speaker', { presetId })
        })
    }

    async exportPresetData(
        presetId: string
    ): Promise<LivingMemoryPresetExport> {
        const [entries, userProfiles, presetSpeakers] = await Promise.all([
            this.entries.listEntriesByPreset(presetId),
            this.userProfiles.listUserProfilesByPreset(presetId),
            this.userProfiles.listPresetSpeakers(presetId)
        ])

        return {
            version: 3,
            exportedAt: new Date().toISOString(),
            sourcePresetId: presetId,
            entries: entries.map((entry) => ({
                id: entry.id,
                speakerKeys: [...entry.speakerKeys],
                type: entry.type,
                status: entry.status,
                content: entry.content,
                keywords: [...entry.keywords],
                summary: entry.summary,
                sentiment: entry.sentiment,
                importance: entry.importance,
                sourceConversationId: entry.sourceConversationId,
                sourceOrigins: entry.sourceOrigins,
                isConsolidated: entry.isConsolidated,
                createdAt: entry.createdAt.toISOString(),
                updatedAt: entry.updatedAt.toISOString()
            })),
            userProfiles: userProfiles.map((profile) => ({
                id: profile.id,
                speakerKey: profile.speakerKey,
                speakerLabel: profile.speakerLabel,
                content: profile.content,
                sourceMemoryIds: [...profile.sourceMemoryIds],
                createdAt: profile.createdAt.toISOString(),
                updatedAt: profile.updatedAt.toISOString()
            })),
            presetSpeakers: presetSpeakers.map((speaker) => ({
                speakerKey: speaker.speakerKey,
                speakerLabel: speaker.speakerLabel,
                speakerAliases: [...speaker.speakerAliases],
                speakerId: speaker.speakerId,
                platform: speaker.platform,
                createdAt: speaker.createdAt.toISOString(),
                updatedAt: speaker.updatedAt.toISOString()
            }))
        }
    }

    async importPresetData(
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ): Promise<LivingMemoryPresetImportSummary> {
        const rows = this.buildPresetImportRows(targetPresetId, data)

        await this.runTransaction(async (database) => {
            await runPresetImportBatches(
                'entries',
                rows.entryRows,
                async (batch) => {
                    await database.upsert('living_memory_entry', batch)
                }
            )
            await runPresetImportBatches(
                'entry speaker cleanup',
                rows.entryRows,
                async (batch) => {
                    await database.remove('living_memory_entry_speaker', {
                        presetId: targetPresetId,
                        memoryId: { $in: batch.map((entry) => entry.id) }
                    })
                }
            )
            await runPresetImportBatches(
                'entry speakers',
                rows.entrySpeakerRows,
                async (batch) => {
                    await database.upsert('living_memory_entry_speaker', batch)
                }
            )

            // 用户画像按 presetId + speakerKey 去重：导入前先删除目标预设下
            // 与导入数据 speakerKey 冲突的已有画像，使导入侧完全覆盖目标侧。
            await runPresetImportBatches(
                'user profile cleanup',
                rows.speakerKeys,
                async (batch) => {
                    await database.remove('living_memory_user_profile', {
                        presetId: targetPresetId,
                        speakerKey: { $in: batch }
                    })
                }
            )
            await runPresetImportBatches(
                'user profiles',
                rows.userProfileRows,
                async (batch) => {
                    await database.upsert('living_memory_user_profile', batch)
                }
            )
            await runPresetImportBatches(
                'preset speakers',
                rows.presetSpeakerRows,
                async (batch) => {
                    await database.upsert('living_memory_preset_speaker', batch)
                }
            )
        })

        return {
            entries: data.entries.length,
            userProfiles: data.userProfiles.length,
            presetSpeakers: data.presetSpeakers.length
        }
    }

    private buildPresetImportRows(
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ) {
        const isCrossPresetImport = targetPresetId !== data.sourcePresetId
        const resolveImportId = (
            recordType: 'entry' | 'user-profile',
            sourceId: string
        ) => {
            if (isCrossPresetImport) {
                return createPresetImportId(
                    recordType,
                    targetPresetId,
                    sourceId
                )
            }
            return sourceId
        }
        const resolveEntryImportId = (sourceId: string) => {
            return resolveImportId('entry', sourceId)
        }
        const createEntryRow = (
            entry: LivingMemoryPresetExportEntry,
            isConsolidated: boolean,
            speakerKeys: string[]
        ) => ({
            id: resolveEntryImportId(entry.id),
            presetId: targetPresetId,
            speakerKeys,
            type: entry.type,
            status: entry.status,
            content: entry.content,
            keywords: entry.keywords,
            summary: entry.summary,
            sentiment: entry.sentiment,
            importance: entry.importance,
            sourceConversationId: entry.sourceConversationId,
            sourceOrigins: entry.sourceOrigins,
            isConsolidated,
            createdAt: new Date(entry.createdAt),
            updatedAt: new Date(entry.updatedAt)
        })
        let entryRows: MemoryEntryRecord[]
        if (data.version === 1) {
            entryRows = data.entries.map((entry) =>
                createEntryRow(entry, false, [])
            )
        } else if (data.version === 2) {
            entryRows = data.entries.map((entry) =>
                createEntryRow(
                    entry,
                    isCrossPresetImport ? false : entry.isConsolidated,
                    []
                )
            )
        } else {
            entryRows = data.entries.map((entry) =>
                createEntryRow(
                    entry,
                    isCrossPresetImport ? false : entry.isConsolidated,
                    entry.speakerKeys
                )
            )
        }
        const speakerKeys = [
            ...new Set(data.userProfiles.map((profile) => profile.speakerKey))
        ]
        const userProfileRows = data.userProfiles.map((profile) => ({
            id: resolveImportId('user-profile', profile.id),
            presetId: targetPresetId,
            speakerKey: profile.speakerKey,
            speakerLabel: profile.speakerLabel,
            content: profile.content,
            sourceMemoryIds: profile.sourceMemoryIds.map(resolveEntryImportId),
            createdAt: new Date(profile.createdAt),
            updatedAt: new Date(profile.updatedAt)
        }))
        const presetSpeakerRows = data.presetSpeakers.map((speaker) => ({
            id: createPresetSpeakerId(targetPresetId, speaker.speakerKey),
            presetId: targetPresetId,
            speakerKey: speaker.speakerKey,
            speakerLabel: speaker.speakerLabel,
            speakerAliases: speaker.speakerAliases ?? [speaker.speakerLabel],
            speakerId: speaker.speakerId,
            platform: speaker.platform ?? null,
            createdAt: new Date(speaker.createdAt),
            updatedAt: new Date(speaker.updatedAt)
        }))

        const entrySpeakerRows = entryRows.flatMap(
            createActiveMemorySpeakerRows
        )
        return {
            entryRows,
            entrySpeakerRows,
            speakerKeys,
            userProfileRows,
            presetSpeakerRows
        }
    }

    async listDistinctPresetIds(): Promise<string[]> {
        const [entries, snapshots, jobs, profiles, speakers] =
            await Promise.all([
                this.ctx.database.get('living_memory_entry', {}, ['presetId']),
                this.ctx.database.get('living_memory_snapshot', {}, [
                    'presetId'
                ]),
                this.ctx.database.get('living_memory_job', {}, [
                    'presetId',
                    'kind'
                ]),
                this.ctx.database.get('living_memory_user_profile', {}, [
                    'presetId'
                ]),
                this.ctx.database.get('living_memory_preset_speaker', {}, [
                    'presetId'
                ])
            ])

        return [
            ...new Set(
                [
                    ...entries,
                    ...snapshots,
                    ...jobs.filter((job) => job.kind !== 'index'),
                    ...profiles,
                    ...speakers
                ]
                    .map((record) => record.presetId)
                    .filter((presetId) => presetId.length > 0)
            )
        ]
    }
}
