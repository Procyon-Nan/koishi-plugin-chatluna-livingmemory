import assert from 'node:assert/strict'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository'
import {
    createTestContext,
    withLivingMemoryRepository
} from './persistence-test-utils'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker'

it('persists a failed job as one terminal record with its original start time', async () => {
    const ctx = createTestContext()
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
            startedAt
        )
        const stored = await ctx.database.get('living_memory_job', {})

        assert.equal(stored.length, 1)
        assert.equal(job.status, 'failed')
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

it('persists partial Dream completion without treating it as an abandoned running job', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const job = await repository.createJob(
            { conversationId: 'dream', presetId: 'preset' },
            'dream',
            ''
        )
        const tracker = new LivingMemoryJobTracker(repository)
        await tracker.markRunning(job.id)
        await tracker.markCompleted(
            job.id,
            'checked 10; unprocessed: memory-11',
            'partial'
        )
        assert.deepEqual(await repository.markStaleRunningJobsAsFailed(), [])
        const [stored] = await repository.listJobsByPreset('preset')
        assert.equal(stored.status, 'partial')
        assert.equal(stored.error, null)
        assert.match(stored.detail!, /memory-11/)
        assert.ok(stored.finishedAt)
    })
})
