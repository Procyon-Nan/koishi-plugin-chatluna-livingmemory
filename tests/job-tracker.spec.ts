import assert from 'node:assert/strict'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker'
import { createJobStore, scope } from './workflow-test-utils'

it('tracks job lifecycle from pending through running and terminal states', async () => {
    const jobStore = createJobStore()
    const job = await jobStore.createJob(scope, 'recall', 'input')
    const tracker = new LivingMemoryJobTracker(jobStore)

    assert.equal(job.status, 'pending')
    await tracker.markRunning(job.id)
    assert.equal(job.status, 'running')
    assert.notEqual(job.startedAt, null)

    await tracker.markCompleted(job.id, 'completed detail')
    assert.equal(job.status, 'completed')
    assert.equal(job.detail, 'completed detail')
    assert.notEqual(job.finishedAt, null)

    const failedJob = await jobStore.createJob(scope, 'extract', 'input')
    await tracker.markRunning(failedJob.id)
    await tracker.markFailed(failedJob.id, new Error('failure detail'))
    assert.equal(failedJob.status, 'failed')
    assert.match(failedJob.error ?? '', /failure detail/u)
})
