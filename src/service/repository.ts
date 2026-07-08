import { createHash, randomUUID } from 'crypto'
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
    MemoryScope,
    MemorySnapshotItem,
    MemorySnapshotRecord,
    MemorySourceMessage,
    PresetSpeakerInput,
    PresetSpeakerRecord,
    RecallRepository,
    SnapshotRepository,
    UserProfileInput,
    UserProfileRecord,
    UserProfileRepository
} from '../types'
import {
    createSourceOriginsFromMessages,
    normalizeMemorySourceOrigins
} from './memory/source_origins'

const keywordFingerprintSeparator = '\u0000'

const normalizeKeywords = (keywords: string[] | null | undefined) => {
    return keywords?.length ? keywords.slice(0, 12) : []
}

const normalizeSentiment = (sentiment: string | null | undefined) => {
    const normalized = sentiment?.trim()
    return normalized?.length ? normalized : null
}

const normalizeImportance = (
    importance: number | string | null | undefined
) => {
    let normalized = Number.NaN

    if (typeof importance === 'number') {
        normalized = importance
    } else if (typeof importance === 'string') {
        const trimmed = importance.trim()
        if (trimmed.length > 0) {
            normalized = Number(trimmed)
        }
    }

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

const resolveKeywords = (
    current: Pick<MemoryEntryRecord, 'keywords'>,
    patch: Partial<MemoryMutationInput>
) => {
    if (patch.keywords !== undefined) {
        return normalizeKeywords(patch.keywords)
    }

    return current.keywords
}

const normalizeEntryRecord = (
    record: MemoryEntryRecord
): MemoryEntryRecord => ({
    ...record,
    status: normalizeStatus(record.status),
    sentiment: normalizeSentiment(record.sentiment),
    importance: normalizeImportance(record.importance),
    sourceOrigins: normalizeMemorySourceOrigins(
        (record as { sourceOrigins?: unknown }).sourceOrigins
    ),
    embedding: Array.isArray(record.embedding) ? record.embedding : null,
    embeddingModelId:
        typeof record.embeddingModelId === 'string' &&
        record.embeddingModelId.length > 0
            ? record.embeddingModelId
            : null
})

const normalizeUserProfileRecord = (
    record: UserProfileRecord
): UserProfileRecord => ({
    ...record,
    speakerKey: record.speakerKey.trim(),
    speakerLabel: record.speakerLabel.trim(),
    content: record.content.trim(),
    sourceMemoryIds: Array.isArray(record.sourceMemoryIds)
        ? record.sourceMemoryIds.filter(
              (id): id is string => typeof id === 'string' && id.length > 0
          )
        : []
})

const normalizeOptionalString = (value: string | null | undefined) => {
    const normalized = value?.trim()
    return normalized?.length ? normalized : null
}

const createPresetSpeakerId = (presetId: string, speakerKey: string) => {
    return createHash('sha256')
        .update(`${presetId}\u0000${speakerKey}`)
        .digest('hex')
}

const normalizePresetSpeakerRecord = (
    record: PresetSpeakerRecord
): PresetSpeakerRecord => ({
    ...record,
    speakerKey: record.speakerKey.trim(),
    speakerLabel: record.speakerLabel.trim(),
    speakerId: normalizeOptionalString(record.speakerId)
})

export class LivingMemoryRepository
    implements
        RecallRepository,
        SnapshotRepository,
        JobRepository,
        ExtractionRepository,
        UserProfileRepository
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
                sourceOrigins: 'json',
                embedding: {
                    type: 'json',
                    nullable: true,
                    initial: null
                },
                embeddingModelId: {
                    type: 'string',
                    length: 255,
                    nullable: true,
                    initial: null
                },
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
                recallStrategy: {
                    type: 'string',
                    length: 32,
                    nullable: true,
                    initial: null
                },
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

        this.ctx.model.extend(
            'living_memory_user_profile',
            {
                id: 'string(64)',
                presetId: 'string(255)',
                speakerKey: 'string(255)',
                speakerLabel: 'string(255)',
                content: 'text',
                sourceMemoryIds: 'json',
                createdAt: 'timestamp',
                updatedAt: 'timestamp'
            },
            {
                autoInc: false,
                primary: 'id'
            }
        )

        this.ctx.model.extend(
            'living_memory_preset_speaker',
            {
                id: 'string(64)',
                presetId: 'string(255)',
                speakerKey: 'string(255)',
                speakerLabel: 'string(255)',
                speakerId: {
                    type: 'string',
                    length: 255,
                    nullable: true,
                    initial: null
                },
                createdAt: 'timestamp',
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
                status: normalizeStatus(item.status),
                content: item.content,
                keywords: normalizeKeywords(item.keywords),
                summary: item.summary ?? null,
                sentiment: normalizeSentiment(item.sentiment),
                importance: normalizeImportance(item.importance),
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
            status: normalizeStatus(input.status),
            content: input.content,
            keywords: normalizeKeywords(input.keywords),
            summary: input.summary ?? null,
            sentiment: normalizeSentiment(input.sentiment),
            importance: normalizeImportance(input.importance),
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

        const content = patch.content ?? current.content
        const keywords = resolveKeywords(current, patch)
        const summary =
            patch.summary === undefined
                ? (current.summary ?? null)
                : patch.summary
        const status =
            patch.status === undefined
                ? normalizeStatus(current.status)
                : normalizeStatus(patch.status)
        const sentiment =
            patch.sentiment === undefined
                ? normalizeSentiment(current.sentiment)
                : normalizeSentiment(patch.sentiment)
        const importance =
            patch.importance === undefined
                ? normalizeImportance(current.importance)
                : normalizeImportance(patch.importance)
        // 内容/摘要/关键词变化时需要让已缓存的向量失效，由召回时按需重算
        const semanticChanged =
            content !== current.content ||
            summary !== (current.summary ?? null) ||
            keywords.join(keywordFingerprintSeparator) !==
                current.keywords.join(keywordFingerprintSeparator)

        await this.ctx.database.set(
            'living_memory_entry',
            { id },
            {
                type: patch.type ?? current.type,
                status,
                content,
                keywords,
                summary,
                sentiment,
                importance,
                ...(semanticChanged
                    ? { embedding: null, embeddingModelId: null }
                    : {}),
                updatedAt: new Date()
            }
        )
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
