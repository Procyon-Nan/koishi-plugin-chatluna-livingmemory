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
    DreamMemoryEntryRecord,
    DreamMergeInput,
    ExtractedMemoryItem,
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

const sourceOriginsArrayMigrationId = 'source-origins-array-v1'
const legacyEmbeddingMigrationId = 'legacy-embedding-vector-index-v1'
const memoryEntryFields: (keyof MemoryEntryRecord)[] = [
    'id',
    'presetId',
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

    async listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]> {
        return await this.ctx.database.get(
            'living_memory_entry',
            { presetId },
            [
                'id',
                'presetId',
                'type',
                'status',
                'content',
                'keywords',
                'summary',
                'sentiment',
                'importance',
                'isConsolidated',
                'createdAt',
                'updatedAt'
            ]
        )
    }

    async listEntryIndexSourcePage(
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        const selection = this.ctx.database.select('living_memory_entry')
        if (afterId !== null) {
            selection.where({ id: { $gt: afterId } })
        }
        return await selection
            .orderBy('id', 'asc')
            .limit(limit)
            .execute([
                'id',
                'presetId',
                'status',
                'type',
                'isConsolidated',
                'content',
                'keywords',
                'updatedAt'
            ])
    }

    async listEntryIndexSourcePageByPreset(
        presetId: string,
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]> {
        const selection = this.ctx.database.select('living_memory_entry', {
            presetId
        })
        if (afterId !== null) {
            selection.where({ id: { $gt: afterId } })
        }
        return await selection
            .orderBy('id', 'asc')
            .limit(limit)
            .execute([
                'id',
                'presetId',
                'status',
                'type',
                'isConsolidated',
                'content',
                'keywords',
                'updatedAt'
            ])
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
            { presetId }
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

    async countPendingEntries(presetId: string): Promise<number> {
        const entries = await this.ctx.database.get(
            'living_memory_entry',
            { presetId, isConsolidated: false },
            ['id']
        )
        return entries.length
    }

    async listPendingEntries(
        presetId: string,
        limit: number
    ): Promise<MemoryEntryRecord[]> {
        const entries = await this.ctx.database
            .select('living_memory_entry', {
                presetId,
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
            [
                'id',
                'type',
                'content',
                'keywords',
                'summary',
                'importance',
                'createdAt',
                'updatedAt'
            ]
        )
    }

    async appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: ExtractedMemoryItem[]
    ) {
        if (extracted.length === 0) {
            return []
        }

        const now = new Date()
        const sourceOrigins =
            createSourceOriginsFromMessages(sourceOriginMessages)
        const records = extracted.map((item): MemoryEntryRecord => ({
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
            isConsolidated: false,
            createdAt: now,
            updatedAt: now
        }))
        await this.ctx.database.upsert('living_memory_entry', records)
        return records
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
            isConsolidated: false,
            createdAt: now,
            updatedAt: now
        }

        await this.ctx.database.create('living_memory_entry', record)
        return record
    }

    async updateMemory(id: string, patch: Partial<MemoryMutationInput>) {
        const current = await this.getEntryById(id)
        if (current == null) {
            return null
        }

        await this.ctx.database.set(
            'living_memory_entry',
            { id },
            {
                ...this.buildMemoryUpdatePatch(current, patch),
                updatedAt: new Date()
            }
        )
        const record = await this.requireEntryById(id, 'memory update')
        return {
            record,
            contentChanged: record.content !== current.content
        }
    }

    async updateMemoryForDream(
        id: string,
        patch: Partial<MemoryMutationInput>,
        isConsolidated: boolean
    ) {
        const current = await this.getEntryById(id)
        if (current == null) {
            throw new Error(`dream update failed: memory not found: ${id}`)
        }

        await this.ctx.database.set(
            'living_memory_entry',
            { id },
            {
                ...this.buildMemoryUpdatePatch(current, patch),
                isConsolidated,
                updatedAt: new Date()
            }
        )
        const record = await this.requireEntryById(id, 'dream update')
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

        let expectedStatus: MemoryEntryRecord['status'] = 'active'
        if (input.sourceDisposition === 'delete') {
            expectedStatus = 'archived'
        }
        if (input.patch.status !== expectedStatus) {
            throw new Error('dream merge failed: stage disposition mismatch')
        }

        return await this.ctx.database.transact(async (database) => {
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
            const targetContentChanged = input.patch.content !== target.content
            const targetResult = await database.set(
                'living_memory_entry',
                {
                    id: target.id,
                    status: expectedStatus,
                    updatedAt: input.target.updatedAt
                },
                {
                    ...this.buildMemoryUpdatePatch(target, input.patch),
                    sourceOrigins: mergeMemorySourceOrigins([
                        target,
                        ...sources
                    ]),
                    isConsolidated: input.targetIsConsolidated,
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
                        isConsolidated: input.sourceIsConsolidated,
                        updatedAt
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
                    throw new Error(
                        'dream merge failed: committed target not found'
                    )
                }
                return {
                    target: committedTarget,
                    archivedSources: sourceIds.map((id) => {
                        const source = committedById.get(id)
                        if (source == null) {
                            throw new Error(
                                `dream merge failed: committed source not found: ${id}`
                            )
                        }
                        return source
                    }),
                    deletedSourceIds: [],
                    targetContentChanged
                }
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
            const committedTarget = (
                await database.get(
                    'living_memory_entry',
                    { id: target.id },
                    memoryEntryFields
                )
            )[0]
            if (committedTarget == null) {
                throw new Error(
                    'dream merge failed: committed target not found'
                )
            }
            return {
                target: normalizeEntryRecord(committedTarget),
                archivedSources: [],
                deletedSourceIds: sourceIds,
                targetContentChanged
            }
        })
    }

    async deleteMemory(id: string) {
        const current = await this.getEntryById(id)
        if (current == null) {
            return null
        }
        await this.ctx.database.remove('living_memory_entry', { id })
        return current
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
        return {
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
