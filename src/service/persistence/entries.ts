import { randomUUID } from 'crypto'
import { $, Context } from 'koishi'
import type {
    MemoryEntryRecord,
    MemoryMutationInput,
    MemoryScope,
    MemorySourceMessage
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
    RecallRepository
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
import { normalizeEntryRecord } from './normalizers'
import {
    createUserProfileSpeakerKey,
    normalizeSpeakerKeys
} from '../memory/speaker_identity'

const sourceOriginsArrayMigrationId = 'source-origins-array-v1'
const legacyEmbeddingMigrationId = 'legacy-embedding-vector-index-v1'
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

type EntryTransaction = Parameters<
    Parameters<Context['database']['transact']>[0]
>[0]

interface DreamMergeContext {
    database: EntryTransaction
    input: DreamMergeInput
    sourceIds: string[]
    target: MemoryEntryRecord
    sources: MemoryEntryRecord[]
    updatedAt: Date
    targetContentChanged: boolean
}

export class LivingMemoryEntryRepository
    implements RecallRepository, ExtractionRepository
{
    constructor(private readonly ctx: Context) {}

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

    async hasMigratedLegacyEmbeddings() {
        const records = await this.ctx.database.get(
            'living_memory_migration',
            { id: legacyEmbeddingMigrationId },
            ['id']
        )
        return records.length > 0
    }

    async completeLegacyEmbeddingMigration() {
        await this.ctx.database.withTransaction(async (database) => {
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
        await this.ctx.database.upsert('living_memory_entry', records)
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
        await this.ctx.database.create('living_memory_entry', record)
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

    async updateMemory(id: string, patch: Partial<MemoryMutationInput>) {
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
        await this.ctx.database.set(
            'living_memory_entry',
            { id: current.id },
            {
                ...this.buildMemoryUpdatePatch(current, patch),
                ...(isConsolidated === undefined ? {} : { isConsolidated }),
                updatedAt: new Date()
            }
        )
        const record = await this.requireEntryById(current.id, operation)
        return {
            record,
            contentChanged: record.content !== current.content
        }
    }

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
        await this.ctx.database.set(
            'living_memory_entry',
            {
                presetId,
                status: 'active',
                id: { $in: records.map((record) => record.id) }
            },
            { status: 'archived', updatedAt }
        )
        return records.map((record) => ({
            ...record,
            status: 'archived' as const,
            updatedAt
        }))
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

        return await this.ctx.database.transact(async (database) => {
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
        database: EntryTransaction,
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
        await this.ctx.database.remove('living_memory_entry', { id })
        return current
    }

    async deleteEntries(presetId: string, ids: string[]) {
        if (ids.length === 0) {
            return
        }
        await this.ctx.database.remove('living_memory_entry', {
            presetId,
            id: { $in: ids }
        })
    }

    private async requireEntryById(id: string, operation: string) {
        const record = await this.getEntryById(id)
        if (record == null) {
            throw new Error(`${operation} failed: memory not found: ${id}`)
        }
        return record
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
