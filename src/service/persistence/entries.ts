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
    DreamMemoryRepository,
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
    normalizeMemorySourceOrigins
} from '../memory/origins/source_origins'
import { normalizeEntryRecord } from './normalizers'

const sourceOriginsArrayMigrationId = 'source-origins-array-v1'
const keywordFingerprintSeparator = '\u0000'

export class LivingMemoryEntryRepository
    implements RecallRepository, ExtractionRepository, DreamMemoryRepository
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

    async listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]> {
        const entries = await this.ctx.database.get('living_memory_entry', {
            presetId
        })

        return entries.map(normalizeEntryRecord)
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
            .execute()

        return entries.map(normalizeEntryRecord)
    }

    async listConsolidatedEntries(
        presetId: string
    ): Promise<MemoryEntryRecord[]> {
        const entries = await this.ctx.database.get('living_memory_entry', {
            presetId,
            isConsolidated: true
        })
        return entries.map(normalizeEntryRecord)
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
                isConsolidated: false,
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
    }

    async setMemoryConsolidation(ids: string[], isConsolidated: boolean) {
        await this.ctx.database.set(
            'living_memory_entry',
            { id: { $in: ids } },
            { isConsolidated }
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

        let expectedStatus: MemoryEntryRecord['status'] = 'active'
        if (input.sourceDisposition === 'delete') {
            expectedStatus = 'archived'
        }
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
}
