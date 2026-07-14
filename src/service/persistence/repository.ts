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
import { LivingMemoryEntryRepository } from './entries'
import { LivingMemoryJobRepository } from './jobs'
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
