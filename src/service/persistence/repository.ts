import { Context } from 'koishi'
import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
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
import { LivingMemoryEntryRepository } from './entries'
import { LivingMemoryJobRepository } from './jobs'
import { createPresetImportId, createPresetSpeakerId } from './normalizers'
import { LivingMemorySnapshotRepository } from './snapshots'
import { defineLivingMemoryTables } from './tables'
import { LivingMemoryUserProfileRepository } from './user_profiles'

export class LivingMemoryRepository
    implements
        RecallRepository,
        SnapshotRepository,
        JobRepository,
        ExtractionRepository,
        DreamMergeRepository,
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

    listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]> {
        return this.entries.listEntriesByPreset(presetId)
    }

    countEntriesCreatedAfter(
        presetId: string,
        createdAfter?: Date
    ): Promise<number> {
        return this.entries.countEntriesCreatedAfter(presetId, createdAfter)
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

    async getEntriesWithStaleEmbeddings(
        currentModelId: string
    ): Promise<MemoryEntryRecord[]> {
        const all = await this.ctx.database.get('living_memory_entry', {
            status: 'active'
        })
        return all.filter(
            (entry) =>
                entry.embeddingModelId !== currentModelId ||
                !Array.isArray(entry.embedding) ||
                entry.embedding.length === 0
        )
    }

    appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: ExtractedMemoryItem[]
    ): Promise<void> {
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

    updateMemory(
        id: string,
        patch: Partial<MemoryMutationInput>
    ): Promise<void> {
        return this.entries.updateMemory(id, patch)
    }

    applyDreamMerge(input: DreamMergeInput): Promise<void> {
        return this.entries.applyDreamMerge(input)
    }

    updateEntryEmbeddings(
        updates: {
            id: string
            embedding: number[]
            embeddingModelId: string
        }[]
    ): Promise<void> {
        return this.entries.updateEntryEmbeddings(updates)
    }

    deleteMemory(id: string): Promise<void> {
        return this.entries.deleteMemory(id)
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

    getLatestJobByPresetAndKind(
        presetId: string,
        kind: MemoryJobKind
    ): Promise<MemoryJobRecord | undefined> {
        return this.jobs.getLatestJobByPresetAndKind(presetId, kind)
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
            version: 1,
            exportedAt: new Date().toISOString(),
            sourcePresetId: presetId,
            entries: entries.map((entry) => ({
                id: entry.id,
                type: entry.type,
                status: entry.status,
                content: entry.content,
                keywords: [...entry.keywords],
                summary: entry.summary,
                sentiment: entry.sentiment,
                importance: entry.importance,
                sourceConversationId: entry.sourceConversationId,
                sourceOrigins: entry.sourceOrigins,
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
                speakerId: speaker.speakerId,
                createdAt: speaker.createdAt.toISOString(),
                updatedAt: speaker.updatedAt.toISOString()
            }))
        }
    }

    async importPresetData(
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ): Promise<LivingMemoryPresetImportResult> {
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
        const entryIdBySourceId = new Map(
            data.entries.map((entry) => [
                entry.id,
                resolveImportId('entry', entry.id)
            ])
        )
        const resolveEntryImportId = (sourceId: string) => {
            return (
                entryIdBySourceId.get(sourceId) ??
                resolveImportId('entry', sourceId)
            )
        }

        if (data.entries.length > 0) {
            await this.ctx.database.upsert(
                'living_memory_entry',
                data.entries.map((entry) => ({
                    id: resolveEntryImportId(entry.id),
                    presetId: targetPresetId,
                    type: entry.type,
                    status: entry.status,
                    content: entry.content,
                    keywords: entry.keywords,
                    summary: entry.summary,
                    sentiment: entry.sentiment,
                    importance: entry.importance,
                    sourceConversationId: entry.sourceConversationId,
                    sourceOrigins: entry.sourceOrigins,
                    embedding: null,
                    embeddingModelId: null,
                    createdAt: new Date(entry.createdAt),
                    updatedAt: new Date(entry.updatedAt)
                }))
            )
        }

        if (data.userProfiles.length > 0) {
            // 用户画像按 presetId + speakerKey 去重：导入前先删除目标预设下
            // 与导入数据 speakerKey 冲突的已有画像，使导入侧完全覆盖目标侧。
            const speakerKeys = [
                ...new Set(
                    data.userProfiles.map((profile) => profile.speakerKey)
                )
            ]
            await this.ctx.database.remove('living_memory_user_profile', {
                presetId: targetPresetId,
                speakerKey: { $in: speakerKeys }
            })
            await this.ctx.database.upsert(
                'living_memory_user_profile',
                data.userProfiles.map((profile) => ({
                    id: resolveImportId('user-profile', profile.id),
                    presetId: targetPresetId,
                    speakerKey: profile.speakerKey,
                    speakerLabel: profile.speakerLabel,
                    content: profile.content,
                    sourceMemoryIds:
                        profile.sourceMemoryIds.map(resolveEntryImportId),
                    createdAt: new Date(profile.createdAt),
                    updatedAt: new Date(profile.updatedAt)
                }))
            )
        }

        if (data.presetSpeakers.length > 0) {
            await this.ctx.database.upsert(
                'living_memory_preset_speaker',
                data.presetSpeakers.map((speaker) => ({
                    id: createPresetSpeakerId(
                        targetPresetId,
                        speaker.speakerKey
                    ),
                    presetId: targetPresetId,
                    speakerKey: speaker.speakerKey,
                    speakerLabel: speaker.speakerLabel,
                    speakerId: speaker.speakerId,
                    createdAt: new Date(speaker.createdAt),
                    updatedAt: new Date(speaker.updatedAt)
                }))
            )
        }

        return {
            entries: data.entries.length,
            userProfiles: data.userProfiles.length,
            presetSpeakers: data.presetSpeakers.length
        }
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
}
