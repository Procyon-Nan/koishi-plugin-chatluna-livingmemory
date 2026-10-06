import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils'

const agenticItem = {
    finalText: '我记得张三在准备考试。',
    toolCallSummary: {
        searchTexts: ['张三在准备考试'],
        searchKeywords: [],
        maxCandidates: 30
    },
    matchedMemories: []
}

it('updates the latest snapshot and removes stale duplicates', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const scope = {
            conversationId: 'conversation-1',
            presetId: 'preset-1'
        }
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-old',
            ...scope,
            query: 'old query',
            items: [],
            createdAt: new Date('2026-07-14T00:00:00.000Z')
        })
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-latest',
            ...scope,
            query: 'latest query',
            items: [],
            createdAt: new Date('2026-07-14T01:00:00.000Z')
        })

        await repository.upsertSnapshot(scope, 'replacement query', [
            agenticItem
        ])

        const stored = await repository.listSnapshotsByPreset(scope.presetId)
        assert.equal(stored.length, 1)
        assert.equal(stored[0].id, 'snapshot-latest')
        assert.equal(stored[0].query, 'replacement query')
        assert.deepEqual(stored[0].items, [agenticItem])

        const deleted = await repository.deleteSnapshot(stored[0].id)
        assert.equal(deleted?.id, stored[0].id)
        assert.equal(await repository.deleteSnapshot(stored[0].id), undefined)
    })
})

it('removes legacy memory reference snapshots once', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const createdAt = new Date('2026-07-14T00:00:00.000Z')
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-reference',
            conversationId: 'conversation-1',
            presetId: 'preset-1',
            query: 'reference query',
            items: [{ memoryId: 'memory-1', score: 0.8 }] as never,
            createdAt
        })
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-agentic',
            conversationId: 'conversation-2',
            presetId: 'preset-1',
            query: 'agentic query',
            items: [agenticItem],
            createdAt
        })

        assert.equal(await repository.removeLegacyReferenceSnapshots(), 1)
        assert.deepEqual(
            (await repository.listSnapshotsByPreset('preset-1')).map(
                (snapshot) => snapshot.id
            ),
            ['snapshot-agentic']
        )

        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-after-migration',
            conversationId: 'conversation-3',
            presetId: 'preset-1',
            query: 'reference query',
            items: [{ memoryId: 'memory-2', score: 0.5 }] as never,
            createdAt
        })
        assert.equal(await repository.removeLegacyReferenceSnapshots(), 0)
    })
})
