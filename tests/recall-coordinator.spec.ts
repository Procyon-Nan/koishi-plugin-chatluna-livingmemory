import assert from 'node:assert/strict'
import type {
    LivingMemoryTranscriptMessage,
    MemoryRecallStrategy,
    MemorySnapshotItem
} from '../src/contracts/memory'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker'
import {
    LivingMemoryRecallCoordinator,
    type RecallWorkflowRepository
} from '../src/service/workflows/recall/coordinator'
import type { RecallQueryResult } from '../src/service/workflows/recall/query_builder'
import {
    createAgenticTrace,
    createJobStore,
    createRecallQueryResult,
    currentMessage,
    debug,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'

it('completes embedding-rerank recall and hydrates its snapshot', async () => {
    const jobStore = createJobStore()
    const snapshots: {
        strategy: MemoryRecallStrategy
        query: string
        items: MemorySnapshotItem[]
    }[] = []
    let hydrated = 0
    const repository: RecallWorkflowRepository = {
        createJob: jobStore.createJob,
        upsertSnapshot: async (_scope, strategy, query, items) => {
            snapshots.push({ strategy, query, items })
        }
    }
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        repository,
        { resolve: async () => createRecallQueryResult() },
        {
            retrieve: async () => [
                { id: 'memory-1', content: 'matched content', score: 0.9 }
            ]
        },
        { run: async () => createAgenticTrace('unused') },
        {
            hydrate: async () => {
                hydrated += 1
                return ''
            }
        },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'embedding recall'
    )

    assert.equal(jobStore.jobs[0]?.recallStrategy, 'embedding-rerank')
    assert.deepEqual(snapshots, [
        {
            strategy: 'embedding-rerank',
            query: '记忆查询',
            items: [{ memoryId: 'memory-1', score: 0.9 }]
        }
    ])
    assert.equal(hydrated, 1)
})

it('completes agentic recall and writes the selected snapshot', async () => {
    const jobStore = createJobStore()
    const snapshots: MemorySnapshotItem[][] = []
    const repository: RecallWorkflowRepository = {
        createJob: jobStore.createJob,
        upsertSnapshot: async (_scope, _strategy, _query, items) => {
            snapshots.push(items)
        }
    }
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'agentic-recall', recallTopK: 3 },
        repository,
        { resolve: async () => createRecallQueryResult() },
        { retrieve: async () => [] },
        { run: async () => createAgenticTrace('remembered context') },
        { hydrate: async () => '' },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'agentic recall'
    )

    assert.equal(jobStore.jobs[0]?.recallStrategy, 'agentic-recall')
    assert.equal(snapshots.length, 1)
    assert.equal(
        (snapshots[0]?.[0] as { finalText: string }).finalText,
        'remembered context'
    )
})

it('keeps the previous snapshot when agentic recall returns <NO_MEMORY>', async () => {
    const jobStore = createJobStore()
    let snapshotWrites = 0
    const repository: RecallWorkflowRepository = {
        createJob: jobStore.createJob,
        upsertSnapshot: async () => {
            snapshotWrites += 1
        }
    }
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'agentic-recall', recallTopK: 3 },
        repository,
        { resolve: async () => createRecallQueryResult() },
        { retrieve: async () => [] },
        { run: async () => createAgenticTrace('') },
        { hydrate: async () => '' },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'agentic no-memory recall'
    )

    assert.equal(snapshotWrites, 0)
    assert.equal(
        jobStore.jobs[0]?.detail,
        'no memory selected; snapshot unchanged'
    )
})

it('serializes recall jobs for the same scope', async () => {
    const jobStore = createJobStore()
    let resolveQuery!: (result: RecallQueryResult) => void
    let queryCalls = 0
    const queryResult = new Promise<RecallQueryResult>((resolve) => {
        resolveQuery = resolve
    })
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createJob: jobStore.createJob,
            upsertSnapshot: async () => {}
        },
        {
            resolve: async () => {
                queryCalls += 1
                return await queryResult
            }
        },
        { retrieve: async () => [] },
        { run: async () => createAgenticTrace('unused') },
        { hydrate: async () => '' },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await coordinator.queue(scope, currentMessage, async () => [])
    assert.equal(queryCalls, 1)

    resolveQuery(createRecallQueryResult())
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'serialized recall'
    )
})

it('marks a recall job failed when retrieval throws', async () => {
    const jobStore = createJobStore()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createJob: jobStore.createJob,
            upsertSnapshot: async () => {}
        },
        { resolve: async () => createRecallQueryResult() },
        {
            retrieve: async () => {
                throw new Error('retrieval failure')
            }
        },
        { run: async () => createAgenticTrace('unused') },
        { hydrate: async () => '' },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs[0]?.status === 'failed', 'failed recall')

    assert.match(jobStore.jobs[0]?.error ?? '', /retrieval failure/u)
})

it('does not create a recall job when the query is skipped', async () => {
    const jobStore = createJobStore()
    let queryCalls = 0
    let retrieverCalls = 0
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createJob: jobStore.createJob,
            upsertSnapshot: async () => {}
        },
        {
            resolve: async () => {
                queryCalls += 1
                return createRecallQueryResult('', {
                    cleanedQuery: '',
                    fallbackReason: null,
                    skippedReason: 'empty-cleaned-query'
                })
            }
        },
        {
            retrieve: async () => {
                retrieverCalls += 1
                return []
            }
        },
        { run: async () => createAgenticTrace('unused') },
        { hydrate: async () => '' },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => queryCalls === 1, 'skipped recall query')

    assert.equal(jobStore.jobs.length, 0)
    assert.equal(retrieverCalls, 0)
})

it('continues recall with empty history when history loading fails', async () => {
    const jobStore = createJobStore()
    let receivedHistory: LivingMemoryTranscriptMessage[] | undefined
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createJob: jobStore.createJob,
            upsertSnapshot: async () => {}
        },
        {
            resolve: async (_scope, _message, historyMessages) => {
                receivedHistory = historyMessages
                return createRecallQueryResult()
            }
        },
        { retrieve: async () => [] },
        { run: async () => createAgenticTrace('unused') },
        { hydrate: async () => '' },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => {
        throw new Error('history unavailable')
    })
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'recall after history failure'
    )

    assert.deepEqual(receivedHistory, [])
})

it('marks an agentic recall job failed when its executor throws', async () => {
    const jobStore = createJobStore()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'agentic-recall', recallTopK: 3 },
        {
            createJob: jobStore.createJob,
            upsertSnapshot: async () => {}
        },
        { resolve: async () => createRecallQueryResult() },
        { retrieve: async () => [] },
        {
            run: async () => {
                throw new Error('agentic failure')
            }
        },
        { hydrate: async () => '' },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () => jobStore.jobs[0]?.status === 'failed',
        'failed agentic recall'
    )

    assert.equal(jobStore.jobs[0]?.recallStrategy, 'agentic-recall')
    assert.match(jobStore.jobs[0]?.error ?? '', /agentic failure/u)
})
