import assert from 'node:assert/strict'
import type { MemoryEntryStatus } from '../src/contracts/memory'
import type { AttributedMemoryItem } from '../src/contracts/workflows'
import { LivingMemoryRepository } from '../src/service/persistence/repository'
import {
    createTestContext,
    withLivingMemoryRepository as withRepository
} from './persistence-test-utils'

const scope = {
    conversationId: 'conversation-1',
    presetId: 'preset-1'
}

const createMergePatch = (): AttributedMemoryItem => ({
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

it('atomically creates a memory and archives all merge sources', async () => {
    await withRepository(async (ctx, repository) => {
        const target = await createMemory(repository, 'target', 'active')
        const source1 = await createMemory(repository, 'source-1', 'active')
        const source2 = await createMemory(repository, 'source-2', 'active')
        const sourceOrigins = [
            {
                messages: [
                    {
                        role: 'user' as const,
                        content: 'merged source message',
                        transcriptLines: ['Alice说：merged source message']
                    }
                ]
            }
        ]
        await ctx.database.set(
            'living_memory_entry',
            { id: source1.id },
            { sourceOrigins }
        )

        const merged = await repository.mergeMemories(
            scope.presetId,
            [target.id, source1.id, source2.id],
            createMergePatch()
        )

        const entries = await repository.getEntriesByPresetAndIds(
            scope.presetId,
            [merged.memory.id, target.id, source1.id, source2.id]
        )
        const entryById = new Map(entries.map((entry) => [entry.id, entry]))
        const storedTarget = entryById.get(merged.memory.id)

        assert.equal(storedTarget?.content, 'merged content')
        assert.deepEqual(storedTarget?.speakerKeys, ['replacement-speaker'])
        assert.deepEqual(storedTarget?.sourceOrigins, sourceOrigins)
        assert.equal(entryById.get(source1.id)?.status, 'archived')
        assert.equal(entryById.get(source2.id)?.status, 'archived')
        assert.equal(entryById.get(target.id)?.status, 'archived')
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
                    memoryId: merged.memory.id
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
            [
                {
                    role: 'user',
                    content: 'shared, solo, anonymous',
                    transcriptLines: ['shared, solo, anonymous']
                }
            ],
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

it('defines active memory indexes', () => {
    const ctx = createTestContext()
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    assert.deepEqual(
        ctx.model.tables.living_memory_entry.indexes.map((index) => index.keys),
        [{ presetId: 'asc', status: 'asc', updatedAt: 'asc' }]
    )
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
    })
})

it('rejects a Dream merge when a source no longer exists', async () => {
    await withRepository(async (_ctx, repository) => {
        const target = await createMemory(repository, 'target', 'active')
        const before = await repository.getEntryById(target.id)

        await assert.rejects(
            repository.mergeMemories(
                scope.presetId,
                [target.id, 'missing-source'],
                createMergePatch()
            ),
            /missing-source/u
        )

        const after = await repository.getEntryById(target.id)
        assert.deepEqual(after, before)
    })
})
