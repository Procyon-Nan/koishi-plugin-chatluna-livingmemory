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
    ExtractionRepository,
    JobRepository,
    RecallRepository,
    SnapshotRepository,
    UserProfileRepository
} from '../../contracts/workflows'
import { LivingMemoryEntryRepository } from './entries'
import { LivingMemoryJobRepository } from './jobs'
import { createPresetImportId, createPresetSpeakerId } from './normalizers'
import { LivingMemorySnapshotRepository } from './snapshots'
import { defineLivingMemoryTables } from './tables'
import { LivingMemoryUserProfileRepository } from './user_profiles'
import { reconcilePresetSpeaker } from './speaker_reconciliation'

const PRESET_IMPORT_BATCH_SIZE = 100

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
        UserProfileRepository
{
    private readonly entries: LivingMemoryEntryRepository
    private readonly jobs: LivingMemoryJobRepository
    private readonly snapshots: LivingMemorySnapshotRepository
    private readonly userProfiles: LivingMemoryUserProfileRepository

    constructor(private readonly ctx: Context) {
        this.entries = new LivingMemoryEntryRepository(ctx)
        this.jobs = new LivingMemoryJobRepository(ctx)
        this.snapshots = new LivingMemorySnapshotRepository(ctx)
        this.userProfiles = new LivingMemoryUserProfileRepository(ctx)
    }

    defineTables() {
        defineLivingMemoryTables(this.ctx)
    }

    migrateMemorySourceOriginsArray(): Promise<number> {
        return this.entries.migrateMemorySourceOriginsArray()
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

    listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]> {
        return this.entries.listDreamEntriesByPreset(presetId)
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
        input: MemoryMutationInput
    ): Promise<MemoryEntryRecord> {
        return this.entries.createMemory(scope, input)
    }

    updateMemory(id: string, patch: Partial<MemoryMutationInput>) {
        return this.entries.updateMemory(id, patch)
    }

    updateMemoryForDream(
        id: string,
        patch: Partial<MemoryMutationInput>,
        isConsolidated: boolean
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

    reconcilePresetSpeaker(input: PresetSpeakerInput): Promise<void> {
        return reconcilePresetSpeaker(this.ctx.database, input)
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

        await this.ctx.database.withTransaction(async (database) => {
            await runPresetImportBatches(
                'entries',
                rows.entryRows,
                async (batch) => {
                    await database.upsert('living_memory_entry', batch)
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
        let entryRows
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

        return { entryRows, speakerKeys, userProfileRows, presetSpeakerRows }
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
