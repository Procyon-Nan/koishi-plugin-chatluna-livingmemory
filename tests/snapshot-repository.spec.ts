import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils'

it('updates the latest snapshot and removes stale duplicates', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const scope = {
            conversationId: 'conversation-1',
            presetId: 'preset-1'
        }
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-old',
            ...scope,
            strategy: 'embedding-rerank',
            query: 'old query',
            items: [],
            createdAt: new Date('2026-07-14T00:00:00.000Z')
        })
        await ctx.database.create('living_memory_snapshot', {
            id: 'snapshot-latest',
            ...scope,
            strategy: 'embedding-rerank',
            query: 'latest query',
            items: [],
            createdAt: new Date('2026-07-14T01:00:00.000Z')
        })

        await repository.upsertSnapshot(
            scope,
            'agentic-recall',
            'replacement query',
            []
        )

        const stored = await repository.listSnapshotsByPreset(scope.presetId)
        assert.equal(stored.length, 1)
        assert.equal(stored[0].id, 'snapshot-latest')
        assert.equal(stored[0].strategy, 'agentic-recall')
        assert.equal(stored[0].query, 'replacement query')

        const deleted = await repository.deleteSnapshot(stored[0].id)
        assert.equal(deleted?.id, stored[0].id)
        assert.equal(await repository.deleteSnapshot(stored[0].id), undefined)
    })
})
