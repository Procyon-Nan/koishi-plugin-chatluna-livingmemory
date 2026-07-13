import assert from 'node:assert/strict'
import { Context } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository'

it('persists a failed job as one terminal record with its original start time', async () => {
    const ctx = new Context({ baseDir: process.cwd() })
    ctx.plugin(SQLiteDriver, { path: ':memory:' })
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    await ctx.start()

    try {
        const startedAt = new Date('2026-07-13T00:00:00.000Z')
        const job = await repository.createFailedJob(
            { conversationId: 'conversation-1', presetId: 'preset-1' },
            'recall',
            'query input',
            new Error('recall failure'),
            startedAt,
            'embedding-rerank'
        )
        const stored = await ctx.database.get('living_memory_job', {})

        assert.equal(stored.length, 1)
        assert.equal(job.status, 'failed')
        assert.equal(job.recallStrategy, 'embedding-rerank')
        assert.equal(+job.createdAt, +startedAt)
        assert.equal(+job.startedAt!, +startedAt)
        assert.ok(+job.finishedAt! >= +startedAt)
        assert.equal(+job.updatedAt, +job.finishedAt!)
        assert.match(job.error ?? '', /recall failure/u)
        assert.deepEqual(stored, [job])
    } finally {
        await ctx.stop()
    }
})
