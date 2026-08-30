import assert from 'node:assert/strict'
import { Context } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import type { DreamMemoryMutation } from '../src/contracts/workflows'
import { LivingMemoryRepository } from '../src/service/persistence/repository'
import { createTestContext } from './persistence-test-utils'

const scope = {
    conversationId: 'conversation-1',
    presetId: 'preset-1'
}

const createMergePatch = (
    status: DreamMemoryMutation['status']
): DreamMemoryMutation => ({
    speakerKeys: ['replacement-speaker'],
    type: 'fact',
    status,
    content: 'merged content',
    keywords: ['merged'],
    summary: 'merged summary',
    sentiment: 'neutral',
    importance: 0.9
})

const createMemory = (
    repository: LivingMemoryRepository,
    label: string,
    status: DreamMemoryMutation['status']
) =>
    repository.createMemory(
        scope,
        {
            type: 'fact',
            status,
            content: `${label} content`,
            keywords: [label],
            summary: `${label} summary`,
            sentiment: 'neutral',
            importance: 0.5
        },
        [`${label}-speaker`]
    )

const withRepository = async (
    callback: (
        ctx: Context,
        repository: LivingMemoryRepository
    ) => Promise<void>
) => {
    const ctx = createTestContext()
    ctx.plugin(SQLiteDriver, { path: ':memory:' })
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    await ctx.start()

    try {
        await callback(ctx, repository)
    } finally {
        await ctx.stop()
    }
}

it('atomically updates an active Dream merge and archives its sources', async () => {
    await withRepository(async (ctx, repository) => {
        const target = await createMemory(repository, 'target', 'active')
        const source1 = await createMemory(repository, 'source-1', 'active')
        const source2 = await createMemory(repository, 'source-2', 'active')
        const sourceOrigins = [
            {
                messages: [
                    {
                        role: 'user' as const,
                        content: 'merged source message'
                    }
                ]
            }
        ]
        await ctx.database.set(
            'living_memory_entry',
            { id: source1.id },
            { sourceOrigins }
        )

        await repository.applyDreamMerge({
            presetId: scope.presetId,
            target,
            sources: [source1, source2],
            patch: createMergePatch('active'),
            targetIsConsolidated: false,
            sourceIsConsolidated: true
        })

        const entries = await repository.getEntriesByIds([
            target.id,
            source1.id,
            source2.id
        ])
        const entryById = new Map(entries.map((entry) => [entry.id, entry]))
        const storedTarget = entryById.get(target.id)

        assert.equal(storedTarget?.content, 'merged content')
        assert.deepEqual(storedTarget?.speakerKeys, ['replacement-speaker'])
        assert.deepEqual(storedTarget?.sourceOrigins, sourceOrigins)
        assert.equal(entryById.get(source1.id)?.status, 'archived')
        assert.equal(entryById.get(source2.id)?.status, 'archived')
        assert.equal(storedTarget?.isConsolidated, false)
        assert.equal(entryById.get(source1.id)?.isConsolidated, true)
        assert.equal(entryById.get(source2.id)?.isConsolidated, true)
    })
})

it('defines the pending Dream query index', () => {
    const ctx = createTestContext()
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()

    assert.deepEqual(
        ctx.model.tables.living_memory_entry.indexes.map((index) => index.keys),
        [
            {
                presetId: 'asc',
                status: 'asc',
                isConsolidated: 'asc',
                createdAt: 'asc',
                id: 'asc'
            }
        ]
    )
})

it('counts pending memories and selects the earliest stable batch', async () => {
    await withRepository(async (ctx, repository) => {
        const entries = await Promise.all([
            createMemory(repository, 'memory-a', 'active'),
            createMemory(repository, 'memory-b', 'active'),
            createMemory(repository, 'memory-c', 'archived'),
            createMemory(repository, 'memory-d', 'active')
        ])
        const firstTime = new Date('2026-08-01T00:00:00.000Z')
        const secondTime = new Date('2026-08-02T00:00:00.000Z')
        await ctx.database.set(
            'living_memory_entry',
            { id: { $in: [entries[0].id, entries[1].id] } },
            { createdAt: firstTime }
        )
        await ctx.database.set(
            'living_memory_entry',
            { id: { $in: [entries[2].id, entries[3].id] } },
            { createdAt: secondTime }
        )
        await repository.setMemoryConsolidation(
            scope.presetId,
            [entries[3].id],
            true
        )

        assert.equal(await repository.countPendingEntries(scope.presetId), 2)
        const selected = await repository.listPendingEntries(scope.presetId, 2)
        assert.deepEqual(
            selected.map((entry) => entry.id),
            [entries[0].id, entries[1].id].sort((left, right) =>
                left.localeCompare(right)
            )
        )
    })
})

it('reads Dream entries without legacy vectors or source payloads', async () => {
    await withRepository(async (_ctx, repository) => {
        const entry = await createMemory(repository, 'memory-a', 'active')
        await createMemory(repository, 'memory-b', 'archived')

        const records = await repository.listDreamEntriesByPreset(
            scope.presetId
        )

        assert.equal(records.length, 1)
        assert.equal(records[0].id, entry.id)
        assert.equal(Object.hasOwn(records[0], 'embedding'), false)
        assert.equal(Object.hasOwn(records[0], 'embeddingModelId'), false)
        assert.equal(Object.hasOwn(records[0], 'sourceOrigins'), false)
        assert.equal(Object.hasOwn(records[0], 'sourceConversationId'), false)
    })
})

it('rejects a Dream merge when a source no longer exists', async () => {
    await withRepository(async (_ctx, repository) => {
        const target = await createMemory(repository, 'target', 'active')
        const before = await repository.getEntryById(target.id)

        await assert.rejects(
            repository.applyDreamMerge({
                presetId: scope.presetId,
                target,
                sources: [
                    {
                        id: 'missing-source',
                        updatedAt: new Date()
                    }
                ],
                patch: createMergePatch('active'),
                targetIsConsolidated: true,
                sourceIsConsolidated: true
            }),
            /target or source memories changed/u
        )

        const after = await repository.getEntryById(target.id)
        assert.deepEqual(after, before)
    })
})

it('rejects a Dream merge when a source changed after clustering', async () => {
    await withRepository(async (ctx, repository) => {
        const target = await createMemory(repository, 'target', 'active')
        const source = await createMemory(repository, 'source', 'active')
        await ctx.database.set(
            'living_memory_entry',
            { id: source.id },
            {
                content: 'concurrently updated source',
                updatedAt: new Date(+source.updatedAt + 1000)
            }
        )

        await assert.rejects(
            repository.applyDreamMerge({
                presetId: scope.presetId,
                target,
                sources: [source],
                patch: createMergePatch('active'),
                targetIsConsolidated: true,
                sourceIsConsolidated: true
            }),
            /target or source memories changed/u
        )

        const storedTarget = await repository.getEntryById(target.id)
        const storedSource = await repository.getEntryById(source.id)
        assert.equal(storedTarget?.content, 'target content')
        assert.equal(storedSource?.content, 'concurrently updated source')
        assert.equal(storedSource?.status, 'active')
    })
})
