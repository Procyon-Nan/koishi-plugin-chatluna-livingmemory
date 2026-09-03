import assert from 'node:assert/strict'
import { Context } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import type { MemoryEntryStatus } from '../src/contracts/memory'
import type {
    AttributedMemoryItem,
    DreamMemoryMutation
} from '../src/contracts/workflows'
import { LivingMemoryRepository } from '../src/service/persistence/repository'
import { createTestContext } from './persistence-test-utils'

const scope = {
    conversationId: 'conversation-1',
    presetId: 'preset-1'
}

const createMergePatch = (): DreamMemoryMutation => ({
    speakerKeys: ['replacement-speaker'],
    type: 'fact',
    content: 'merged content',
    keywords: ['merged'],
    summary: 'merged summary',
    sentiment: 'neutral',
    importance: 0.9
})

const createExtractedItem = (
    label: string,
    speakerKeys: string[]
): AttributedMemoryItem => ({
    type: 'fact',
    content: `${label} content`,
    keywords: [label],
    summary: `${label} summary`,
    sentiment: 'neutral',
    importance: 0.5,
    speakerKeys
})

const createMemory = (
    repository: LivingMemoryRepository,
    label: string,
    status: MemoryEntryStatus
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
            patch: createMergePatch(),
            targetIsConsolidated: false
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
        assert.equal(entryById.get(source1.id)?.isConsolidated, false)
        assert.equal(entryById.get(source2.id)?.isConsolidated, false)
        assert.deepEqual(
            await repository.listActiveMemorySpeakerLinks(scope.presetId, [
                'target-speaker',
                'source-1-speaker',
                'source-2-speaker',
                'replacement-speaker'
            ]),
            [
                {
                    speakerKey: 'replacement-speaker',
                    memoryId: target.id
                }
            ]
        )
    })
})

it('maintains active memory speaker links across memory lifecycle changes', async () => {
    await withRepository(async (ctx, repository) => {
        const memory = await createMemory(repository, 'memory', 'active')
        assert.deepEqual(
            await repository.listActiveMemorySpeakerKeys(scope.presetId),
            ['memory-speaker']
        )

        await repository.updateMemory(memory.id, {
            speakerKeys: ['replacement-speaker']
        })
        assert.deepEqual(
            await repository.listActiveMemorySpeakerLinks(scope.presetId, [
                'memory-speaker',
                'replacement-speaker'
            ]),
            [
                {
                    speakerKey: 'replacement-speaker',
                    memoryId: memory.id
                }
            ]
        )

        await repository.archiveActiveEntries(scope.presetId, [memory.id])
        assert.deepEqual(
            await repository.listActiveMemorySpeakerKeys(scope.presetId),
            []
        )

        await repository.updateMemory(memory.id, { status: 'active' })
        assert.deepEqual(
            await repository.listActiveMemorySpeakerKeys(scope.presetId),
            ['replacement-speaker']
        )

        await repository.deleteMemory(memory.id)
        assert.deepEqual(
            await repository.listActiveMemorySpeakerKeys(scope.presetId),
            []
        )

        // Extraction 写入同样维护关联索引：多用户记忆按用户逐行建立，
        // speakerKeys 为空的记忆不产生关联行。
        const [shared, solo, anonymous] = await repository.appendMemories(
            scope,
            [],
            [
                createExtractedItem('shared', ['speaker-a', 'speaker-b']),
                createExtractedItem('solo', ['speaker-a']),
                createExtractedItem('anonymous', [])
            ]
        )
        assert.deepEqual(
            await repository.listActiveMemorySpeakerKeys(scope.presetId),
            ['speaker-a', 'speaker-b']
        )
        assert.deepEqual(
            (
                await repository.listActiveMemorySpeakerLinks(scope.presetId, [
                    'speaker-a'
                ])
            ).map((link) => link.memoryId),
            [shared.id, solo.id].sort((left, right) =>
                left.localeCompare(right)
            )
        )
        assert.deepEqual(
            await repository.listActiveMemorySpeakerLinks(scope.presetId, [
                'speaker-b'
            ]),
            [{ speakerKey: 'speaker-b', memoryId: shared.id }]
        )
        const links = await ctx.database.get(
            'living_memory_entry_speaker',
            {},
            ['memoryId']
        )
        assert.equal(links.length, 3)
        assert.equal(
            links.some((link) => link.memoryId === anonymous.id),
            false
        )
    })
})

it('backfills active memory speaker links once', async () => {
    await withRepository(async (ctx, repository) => {
        const active = await createMemory(repository, 'active', 'active')
        await createMemory(repository, 'archived', 'archived')
        await ctx.database.remove('living_memory_entry_speaker', {})

        assert.equal(await repository.migrateActiveMemorySpeakers(), 1)
        assert.deepEqual(
            await repository.listActiveMemorySpeakerLinks(scope.presetId, [
                'active-speaker',
                'archived-speaker'
            ]),
            [{ speakerKey: 'active-speaker', memoryId: active.id }]
        )
        assert.equal(await repository.migrateActiveMemorySpeakers(), 0)
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
            },
            {
                presetId: 'asc',
                status: 'asc',
                updatedAt: 'asc'
            }
        ]
    )
    assert.deepEqual(
        ctx.model.tables.living_memory_entry_speaker.indexes.map(
            (index) => index.keys
        ),
        [
            { presetId: 'asc', speakerKey: 'asc' },
            { presetId: 'asc', memoryId: 'asc' }
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
        assert.equal(Object.hasOwn(records[0], 'status'), false)
        assert.equal(Object.hasOwn(records[0], 'isConsolidated'), false)
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
                patch: createMergePatch(),
                targetIsConsolidated: true
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
                patch: createMergePatch(),
                targetIsConsolidated: true
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
