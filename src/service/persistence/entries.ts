import { randomUUID } from 'crypto'
import { $, Context } from 'koishi'
import type {
    MemoryEntryRecord,
    MemoryMutationInput,
    MemoryScope,
    MemorySourceMessage,
    MemoryUpdatePatch
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
    RecallRepository,
    UserProfileMemoryRepository
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
    mergeMemorySourceOrigins
} from '../memory/origins/source_origins'
import {
    createActiveMemorySpeakerRows,
    normalizeEntryRecord
} from './normalizers'
import type { LivingMemoryTransact, LivingMemoryTransaction } from './types'
import {
    createUserProfileSpeakerKey,
    normalizeSpeakerKeys
} from '../memory/speaker_identity'

const sourceOriginsArrayMigrationId = 'source-origins-array-v1'
const legacyEmbeddingMigrationId = 'legacy-embedding-vector-index-v1'
const activeMemorySpeakersMigrationId = 'active-memory-speakers-v1'
/**
 * 回填按页读取记忆、按批写入关联行。一条记忆展开出多条关联行，两者不是同一
 * 量纲，因此各自设界。
 */
const ACTIVE_MEMORY_SPEAKER_PAGE_SIZE = 500
const ACTIVE_MEMORY_SPEAKER_BATCH_SIZE = 500
const memoryEntryFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'presetId',
    'speakerKeys',
    'type',
    'status',
    'content',
    'keywords',
    'summary',
    'sentiment',
    'importance',
    'sourceConversationId',
    'sourceOrigins',
    'isConsolidated',
    'createdAt',
    'updatedAt'
]
const indexSourceFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'presetId',
    'status',
    'type',
    'isConsolidated',
    'content',
    'keywords',
    'updatedAt'
]
const dreamEntryFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'presetId',
    'speakerKeys',
    'type',
    'content',
    'keywords',
    'summary',
    'sentiment',
    'importance',
    'createdAt',
    'updatedAt'
]
const recallEntryFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'type',
    'content',
    'keywords',
    'summary',
    'importance',
    'createdAt',
    'updatedAt'
]

interface DreamMergeContext {
    database: LivingMemoryTransaction
    input: DreamMergeInput
    sourceIds: string[]
    target: MemoryEntryRecord
    sources: MemoryEntryRecord[]
    updatedAt: Date
    targetContentChanged: boolean
}

export class LivingMemoryEntryRepository
    implements
        RecallRepository,
        ExtractionRepository,
        UserProfileMemoryRepository
{
    constructor(
        private readonly ctx: Context,
        private readonly transact: LivingMemoryTransact
    ) {}

    /**
     * 回填活跃记忆的用户关联行。读取按 id 游标分页，峰值内存只与单页记忆条数
     * 相关；分页与写入同处一个事务，保持要么整体生效要么不生效的语义与迁移
     * 标记的幂等性。
     */
    async migrateActiveMemorySpeakers(): Promise<number> {
        return await this.transact(async (database) => {
            const applied = await database.get('living_memory_migration', {
                id: activeMemorySpeakersMigrationId
            })
            if (applied.length > 0) {
                return 0
            }

            let cursor: string | null = null
            let rowCount = 0
            do {
                const entries = await this.selectActiveMemorySpeakerPage(
                    database,
                    cursor,
                    ACTIVE_MEMORY_SPEAKER_PAGE_SIZE
                )
                if (entries.length === 0) {
                    break
                }

                const rows = entries.flatMap(createActiveMemorySpeakerRows)
                for (
                    let offset = 0;
                    offset < rows.length;
                    offset += ACTIVE_MEMORY_SPEAKER_BATCH_SIZE
                ) {
                    await database.upsert(
                        'living_memory_entry_speaker',
                        rows.slice(
                            offset,
                            offset + ACTIVE_MEMORY_SPEAKER_BATCH_SIZE
                        )
                    )
                }
                rowCount += rows.length
                cursor = entries[entries.length - 1].id
            } while (true)

            await database.create('living_memory_migration', {
                id: activeMemorySpeakersMigrationId,
                appliedAt: new Date()
            })
            return rowCount
        })
    }

    private async selectActiveMemorySpeakerPage(
        database: LivingMemoryTransaction,
        afterId: string | null,
        limit: number
    ) {
        const selection = database.select('living_memory_entry', {
            status: 'active'
        })
        if (afterId !== null) {
            selection.where({ id: { $gt: afterId } })
        }
        return await selection
            .orderBy('id', 'asc')
            .limit(limit)
            .execute(['id', 'presetId', 'speakerKeys', 'status'])
    }

    async migrateMemorySourceOriginsArray(): Promise<number> {
        return await this.transact(async (database) => {
            const applied = await database.get('living_memory_migration', {
                id: sourceOriginsArrayMigrationId
            })
            if (applied.length > 0) {
                return 0
            }

            const entries = await database.get('living_memory_entry', {}, [
                'id',
                'sourceOrigins'
            ])
            const invalidIds = entries
                .filter((entry) => !Array.isArray(entry.sourceOrigins))
                .map((entry) => entry.id)

            if (invalidIds.length > 0) {
                await database.set(
                    'living_memory_entry',
                    { id: { $in: invalidIds } },
                    { sourceOrigins: [] }
                )
            }

            await database.create('living_memory_migration', {
                id: sourceOriginsArrayMigrationId,
                appliedAt: new Date()
            })
            return invalidIds.length
        })
    }

    async hasMigratedLegacyEmbeddings() {
        const records = await this.ctx.database.get(
            'living_memory_migration',
            { id: legacyEmbeddingMigrationId },
            ['id']
        )
        return records.length > 0
    }

    async completeLegacyEmbeddingMigration() {
        await this.transact(async (database) => {
            const records = await database.get(
                'living_memory_migration',
                { id: legacyEmbeddingMigrationId },
                ['id']
            )
            if (records.length > 0) {
                return
            }
            await database.set(
                'living_memory_entry',
                {},
                { embedding: null, embeddingModelId: null }
            )
            await database.create('living_memory_migration', {
                id: legacyEmbeddingMigrationId,
                appliedAt: new Date()
            })
        })
    }

    async listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]> {
        const entries = await this.ctx.database.get(
            'living_memory_entry',
            { presetId },
            memoryEntryFields
        )

        return entries.map(normalizeEntryRecord)
    }

    async listArchivedEntriesBefore(presetId: string, updatedBefore: Date) {
        return await this.ctx.database.get(
            'living_memory_entry',
            {
                presetId,
                status: 'archived',
                updatedAt: { $lte: updatedBefore }
            },
            ['id', 'importance', 'updatedAt']
        )
    }

    async listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]> {
        return await this.ctx.database.get(
            'living_memory_entry',
            { presetId, status: 'active' },
            dreamEntryFields
        )
    }

    async listActiveMemorySpeakerKeys(presetId: string): Promise<string[]> {
        const rows = await this.ctx.database
            .select('living_memory_entry_speaker', { presetId })
            .groupBy('speakerKey')
            .execute(['speakerKey'])
        return rows.map((row) => row.speakerKey).sort()
    }

    async listActiveMemorySpeakerLinks(
        presetId: string,
        speakerKeys: string[]
    ) {
        if (speakerKeys.length === 0) {
            return []
        }

        const links = await this.ctx.database.get(
            'living_memory_entry_speaker',
            { presetId, speakerKey: { $in: speakerKeys } },
            ['speakerKey', 'memoryId']
        )
        return links.sort(
            (left, right) =>
                left.speakerKey.localeCompare(right.speakerKey) ||
                left.memoryId.localeCompare(right.memoryId)
        )
    }

    async listEntryIndexSourcePage(
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        return this.selectEntryIndexSourcePage(null, afterId, limit)
    }

    async listEntryIndexSourcePageByPreset(
        presetId: string,
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        return this.selectEntryIndexSourcePage(presetId, afterId, limit)
    }

    private async selectEntryIndexSourcePage(
        presetId: string | null,
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        const selection =
            presetId === null
                ? this.ctx.database.select('living_memory_entry')
                : this.ctx.database.select('living_memory_entry', { presetId })
        if (afterId !== null) {
            selection.where({ id: { $gt: afterId } })
        }
        return await selection
            .orderBy('id', 'asc')
            .limit(limit)
            .execute(indexSourceFields)
    }

    async listLegacyEmbeddingPage(
        afterId: string | null,
        limit: number
    ): Promise<LegacyMemoryEmbeddingRecord[]> {
        const selection = this.ctx.database.select('living_memory_entry')
        if (afterId !== null) {
            selection.where({ id: { $gt: afterId } })
        }
        return await selection
            .orderBy('id', 'asc')
            .limit(limit)
            .execute(['id', 'embedding', 'embeddingModelId'])
    }

    countEntriesByPreset(presetId: string) {
        return this.ctx.database.eval(
            'living_memory_entry',
            (entry) => $.count(entry.id),
            {
                presetId
            }
        )
    }

    countEntries() {
        return this.ctx.database.eval('living_memory_entry', (entry) =>
            $.count(entry.id)
        )
    }

    async listEntryPresetIds() {
        const entries = await this.ctx.database
            .select('living_memory_entry')
            .groupBy('presetId')
            .execute(['presetId'])
        return entries.map((entry) => entry.presetId).sort()
    }

    countPendingEntries(presetId: string) {
        return this.ctx.database.eval(
            'living_memory_entry',
            (entry) => $.count(entry.id),
            {
                presetId,
                status: 'active',
                isConsolidated: false
            }
        )
    }

    async listPendingEntries(
        presetId: string,
        limit: number
    ): Promise<MemoryEntryRecord[]> {
        const entries = await this.ctx.database
            .select('living_memory_entry', {
                presetId,
                status: 'active',
                isConsolidated: false
            })
            .orderBy('createdAt', 'asc')
            .orderBy('id', 'asc')
            .limit(limit)
            .execute(memoryEntryFields)

        return entries.map(normalizeEntryRecord)
    }

    async getEntryById(id: string): Promise<MemoryEntryRecord | undefined> {
        const record = (
            await this.ctx.database.get(
                'living_memory_entry',
                { id },
                memoryEntryFields
            )
        )[0]

        return record == null ? undefined : normalizeEntryRecord(record)
    }

    async getEntriesByIds(ids: string[]): Promise<MemoryEntryRecord[]> {
        if (ids.length === 0) {
            return []
        }

        const entries = await this.ctx.database.get(
            'living_memory_entry',
            {
                id: {
                    $in: ids
                }
            },
            memoryEntryFields
        )

        return entries.map(normalizeEntryRecord)
    }

    async getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]> {
        if (ids.length === 0) {
            return []
        }

        const entries = await this.ctx.database.get(
            'living_memory_entry',
            {
                presetId,
                id: {
                    $in: ids
                }
            },
            memoryEntryFields
        )

        return entries.map(normalizeEntryRecord)
    }

    async getRecallEntriesByPresetAndIds(presetId: string, ids: string[]) {
        if (ids.length === 0) {
            return []
        }

        return await this.ctx.database.get(
            'living_memory_entry',
            {
                presetId,
                id: { $in: ids }
            },
            recallEntryFields
        )
    }

    async appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: AttributedMemoryItem[]
    ) {
        if (extracted.length === 0) {
            return []
        }

        const now = new Date()
        const sourceOrigins =
            createSourceOriginsFromMessages(sourceOriginMessages)
        const records = extracted.map((item) =>
            this.buildMemoryEntry(
                scope,
                item,
                sourceOrigins,
                now,
                item.speakerKeys
            )
        )
        await this.transact(async (database) => {
            await database.upsert('living_memory_entry', records)
            await this.replaceActiveMemorySpeakers(database, records)
        })
        return records
    }

    async createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys?: string[]
    ) {
        const record = this.buildMemoryEntry(
            scope,
            input,
            [],
            new Date(),
            speakerKeys ?? this.resolveScopeSpeakerKeys(scope)
        )
        await this.transact(async (database) => {
            await database.create('living_memory_entry', record)
            await this.replaceActiveMemorySpeakers(database, [record])
        })
        return record
    }

    private buildMemoryEntry(
        scope: MemoryScope,
        fields: MemoryMutationInput,
        sourceOrigins: MemoryEntryRecord['sourceOrigins'],
        createdAt: Date,
        speakerKeys: string[]
    ): MemoryEntryRecord {
        return {
            id: randomUUID(),
            presetId: scope.presetId,
            speakerKeys: normalizeSpeakerKeys(speakerKeys),
            type: fields.type,
            status: normalizeMemoryStatus(fields.status),
            content: normalizeMemoryText(fields.content),
            keywords: normalizeMemoryKeywords(fields.keywords),
            summary: normalizeOptionalMemoryText(fields.summary),
            sentiment: normalizeOptionalMemoryText(fields.sentiment),
            importance: normalizeMemoryImportance(fields.importance),
            sourceConversationId: scope.conversationId,
            sourceOrigins,
            isConsolidated: false,
            createdAt,
            updatedAt: createdAt
        }
    }

    private resolveScopeSpeakerKeys(scope: MemoryScope) {
        const platform = scope.platform?.trim()
        const speakerId = (scope.speakerId ?? scope.userId)?.trim()
        return platform && speakerId
            ? [createUserProfileSpeakerKey(platform, speakerId)]
            : []
    }

    async updateMemory(id: string, patch: MemoryUpdatePatch) {
        const current = await this.getEntryById(id)
        if (current == null) {
            return null
        }
        return this.writeMemoryUpdate(current, patch)
    }

    async updateMemoryForDream(
        id: string,
        patch: DreamMemoryMutation | { status: 'archived' },
        isConsolidated?: boolean
    ) {
        const current = await this.getEntryById(id)
        if (current == null) {
            throw new Error(`dream update failed: memory not found: ${id}`)
        }
        if (current.status !== 'active') {
            throw new Error(`dream update failed: memory is not active: ${id}`)
        }
        return this.writeMemoryUpdate(
            current,
            patch,
            isConsolidated,
            'dream update'
        )
    }

    private async writeMemoryUpdate(
        current: MemoryEntryRecord,
        patch: Partial<MemoryMutationInput> & { speakerKeys?: string[] },
        isConsolidated?: boolean,
        operation = 'memory update'
    ) {
        const fields = this.buildMemoryUpdatePatch(current, patch)
        const speakersChanged =
            fields.status !== current.status ||
            fields.speakerKeys.length !== current.speakerKeys.length ||
            fields.speakerKeys.some(
                (speakerKey, index) => speakerKey !== current.speakerKeys[index]
            )
        return await this.transact(async (database) => {
            const updatedAt = new Date()
            const nextRecord = {
                ...current,
                ...fields,
                ...(isConsolidated === undefined ? {} : { isConsolidated }),
                updatedAt
            }
            await database.set(
                'living_memory_entry',
                { id: current.id },
                {
                    ...fields,
                    ...(isConsolidated === undefined ? {} : { isConsolidated }),
                    updatedAt
                }
            )
            if (speakersChanged) {
                await this.replaceActiveMemorySpeakers(database, [nextRecord])
            }
            const stored = (
                await database.get(
                    'living_memory_entry',
                    { id: current.id },
                    memoryEntryFields
                )
            )[0]
            if (stored == null) {
                throw new Error(
                    `${operation} failed: memory not found: ${current.id}`
                )
            }
            const record = normalizeEntryRecord(stored)
            return {
                record,
                contentChanged: record.content !== current.content
            }
        })
    }

    /**
     * 只改 `isConsolidated`，不涉及 `status` 与 `speakerKeys`，因此无需重写
     * `living_memory_entry_speaker`；`set` 本身是单语句原子操作，回读仅用于向量
     * 索引同步。这是记忆写路径中唯一不需要事务的分支。
     */
    async setMemoryConsolidation(
        presetId: string,
        ids: string[],
        isConsolidated: boolean
    ) {
        if (ids.length === 0) {
            return []
        }
        await this.ctx.database.set(
            'living_memory_entry',
            { presetId, id: { $in: ids } },
            { isConsolidated }
        )
        return await this.getEntriesByPresetAndIds(presetId, ids)
    }

    async archiveActiveEntries(presetId: string, ids: string[]) {
        if (ids.length === 0) {
            return []
        }
        const records = (
            await this.getEntriesByPresetAndIds(presetId, ids)
        ).filter((record) => record.status === 'active')
        if (records.length === 0) {
            return []
        }

        const updatedAt = new Date()
        const archived = records.map((record) => ({
            ...record,
            status: 'archived' as const,
            updatedAt
        }))
        await this.transact(async (database) => {
            await database.set(
                'living_memory_entry',
                {
                    presetId,
                    status: 'active',
                    id: { $in: records.map((record) => record.id) }
                },
                { status: 'archived', updatedAt }
            )
            await this.replaceActiveMemorySpeakers(database, archived)
        })
        return archived
    }

    async applyDreamMerge(input: DreamMergeInput) {
        const sourceIds = input.sources.map((source) => source.id)
        const uniqueSourceIds = new Set(sourceIds)
        if (
            uniqueSourceIds.size === 0 ||
            uniqueSourceIds.size !== sourceIds.length ||
            uniqueSourceIds.has(input.target.id)
        ) {
            throw new Error('dream merge failed: invalid source ids')
        }

        return await this.transact(async (database) => {
            const merge = await this.loadDreamMergeState(
                database,
                input,
                sourceIds
            )
            await this.updateDreamMergeTarget(merge)
            return this.commitDreamMergeArchive(merge)
        })
    }

    private async loadDreamMergeState(
        database: LivingMemoryTransaction,
        input: DreamMergeInput,
        sourceIds: string[]
    ): Promise<DreamMergeContext> {
        const entries = (
            await database.get(
                'living_memory_entry',
                {
                    id: {
                        $in: [input.target.id, ...sourceIds]
                    }
                },
                memoryEntryFields
            )
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
            target.presetId !== input.presetId ||
            target.status !== 'active' ||
            +target.updatedAt !== +input.target.updatedAt ||
            sources.length !== sourceIds.length ||
            sources.some(
                (source) =>
                    source.presetId !== target.presetId ||
                    source.status !== 'active' ||
                    +source.updatedAt !==
                        expectedSourceUpdatedAtById.get(source.id)
            )
        ) {
            throw new Error(
                'dream merge failed: target or source memories changed'
            )
        }

        return {
            database,
            input,
            sourceIds,
            target,
            sources,
            updatedAt: new Date(),
            targetContentChanged: input.patch.content !== target.content
        }
    }

    private async updateDreamMergeTarget(merge: DreamMergeContext) {
        const { database, input, target, sources } = merge
        const targetResult = await database.set(
            'living_memory_entry',
            {
                id: target.id,
                status: 'active',
                updatedAt: input.target.updatedAt
            },
            {
                ...this.buildMemoryUpdatePatch(target, input.patch),
                sourceOrigins: mergeMemorySourceOrigins([target, ...sources]),
                isConsolidated: input.targetIsConsolidated,
                updatedAt: merge.updatedAt
            }
        )
        this.assertAffectedCount(targetResult.matched, 1, 'target update')
    }

    private async commitDreamMergeArchive(merge: DreamMergeContext) {
        const { database, input, sourceIds, target } = merge
        const sourceResult = await database.set(
            'living_memory_entry',
            {
                $or: input.sources.map((source) => ({
                    id: source.id,
                    status: 'active' as const,
                    updatedAt: source.updatedAt
                }))
            },
            {
                status: 'archived',
                updatedAt: merge.updatedAt
            }
        )
        this.assertAffectedCount(
            sourceResult.matched,
            sourceIds.length,
            'source archive'
        )
        const committedEntries = (
            await database.get(
                'living_memory_entry',
                { id: { $in: [target.id, ...sourceIds] } },
                memoryEntryFields
            )
        ).map(normalizeEntryRecord)
        await this.replaceActiveMemorySpeakers(database, committedEntries)
        const committedById = new Map(
            committedEntries.map((entry) => [entry.id, entry])
        )
        const committedTarget = committedById.get(target.id)
        if (committedTarget == null) {
            throw new Error('dream merge failed: committed target not found')
        }
        return {
            target: committedTarget,
            archivedSources: sourceIds.map((id) =>
                this.requireCommittedSource(committedById, id)
            ),
            targetContentChanged: merge.targetContentChanged
        }
    }

    private requireCommittedSource(
        committedById: Map<string, MemoryEntryRecord>,
        id: string
    ) {
        const source = committedById.get(id)
        if (source == null) {
            throw new Error(
                `dream merge failed: committed source not found: ${id}`
            )
        }
        return source
    }

    async deleteMemory(id: string) {
        const current = await this.getEntryById(id)
        if (current == null) {
            return null
        }
        await this.transact(async (database) => {
            await database.remove('living_memory_entry', { id })
            await database.remove('living_memory_entry_speaker', {
                presetId: current.presetId,
                memoryId: id
            })
        })
        return current
    }

    async deleteEntries(presetId: string, ids: string[]) {
        if (ids.length === 0) {
            return
        }
        await this.transact(async (database) => {
            await database.remove('living_memory_entry', {
                presetId,
                id: { $in: ids }
            })
            await database.remove('living_memory_entry_speaker', {
                presetId,
                memoryId: { $in: ids }
            })
        })
    }

    private async replaceActiveMemorySpeakers(
        database: LivingMemoryTransaction,
        entries: Pick<
            MemoryEntryRecord,
            'id' | 'presetId' | 'speakerKeys' | 'status'
        >[]
    ) {
        if (entries.length === 0) {
            return
        }

        // 按 presetId 分组删除：入参每条记录自带 presetId，写入侧也按各自的
        // presetId 生成关联行，删除侧必须保持同一口径，否则跨预设批次会残留
        // 旧关联行。删除条件保留 presetId 以命中 (presetId, memoryId) 索引。
        const memoryIdsByPreset = new Map<string, string[]>()
        for (const entry of entries) {
            const memoryIds = memoryIdsByPreset.get(entry.presetId)
            if (memoryIds == null) {
                memoryIdsByPreset.set(entry.presetId, [entry.id])
            } else {
                memoryIds.push(entry.id)
            }
        }
        for (const [presetId, memoryIds] of memoryIdsByPreset) {
            await database.remove('living_memory_entry_speaker', {
                presetId,
                memoryId: { $in: memoryIds }
            })
        }

        const rows = entries.flatMap(createActiveMemorySpeakerRows)
        if (rows.length > 0) {
            await database.upsert('living_memory_entry_speaker', rows)
        }
    }

    private buildMemoryUpdatePatch(
        current: MemoryEntryRecord,
        patch: Partial<MemoryMutationInput> & { speakerKeys?: string[] }
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
        return {
            speakerKeys:
                patch.speakerKeys === undefined
                    ? current.speakerKeys
                    : normalizeSpeakerKeys(patch.speakerKeys),
            type: patch.type ?? current.type,
            status,
            content,
            keywords,
            summary,
            sentiment,
            importance
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
}
