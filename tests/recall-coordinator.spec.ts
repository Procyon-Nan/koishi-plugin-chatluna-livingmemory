import assert from 'node:assert/strict'
import type {
    LivingMemoryTranscriptMessage,
    MemoryRecallStrategy,
    MemorySnapshotItem
} from '../src/contracts/memory'
import {
    LivingMemoryRecallCoordinator,
    type RecallWorkflowRepository
} from '../src/service/workflows/recall/coordinator'
import type { RecallQueryResult } from '../src/service/workflows/recall/query_builder'
import {
    createAgenticTrace,
    createCapturedLogger,
    createJobStore,
    createRecallQueryResult,
    currentMessage,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'

it('completes embedding-rerank recall without persisting a successful job', async () => {
    const jobStore = createJobStore()
    const snapshots: {
        strategy: MemoryRecallStrategy
        query: string
        items: MemorySnapshotItem[]
    }[] = []
    let hydrated = 0
    const captured = createCapturedLogger()
    const repository: RecallWorkflowRepository = {
        createFailedJob: jobStore.createFailedJob,
        upsertSnapshot: async (_scope, strategy, query, items) => {
            snapshots.push({ strategy, query, items })
        }
    }
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        repository,
        { resolve: async () => createRecallQueryResult() },
        {
            retrieve: async (_presetId, _input, _limit, runLogger) => {
                assert.ok(runLogger)
                runLogger.diagnostic('test.retriever.context')
                return [
                    {
                        id: 'memory-1',
                        content: 'matched content',
                        score: 0.9
                    }
                ]
            }
        },
        { run: async () => createAgenticTrace('unused') },
        {
            hydrate: async () => {
                hydrated += 1
                return 'first memory\nsecond memory'
            }
        },
        captured.logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => hydrated === 1, 'embedding recall hydration')

    assert.equal(jobStore.jobs.length, 0)
    assert.deepEqual(snapshots, [
        {
            strategy: 'embedding-rerank',
            query: '记忆查询',
            items: [{ memoryId: 'memory-1', score: 0.9 }]
        }
    ])
    assert.ok(
        captured.info.some((message) =>
            message.includes('event=recall.retrieval.completed')
        )
    )
    const snapshotLog = captured.info.find((message) =>
        message.includes('event=recall.snapshot.updated')
    )
    assert.match(snapshotLog ?? '', /itemCount=1/u)
    assert.match(
        snapshotLog ?? '',
        /--- snapshot\.content ---\nfirst memory\nsecond memory\n--- end recall\.snapshot\.updated ---$/u
    )
    assert.doesNotMatch(snapshotLog ?? '', /first memory\\nsecond memory/u)
    assert.ok(
        captured.info.some((message) =>
            /event=test.retriever.context workflow=recall runId=[^ ]+ presetId=preset-1 conversationId=conversation-1/u.test(
                message
            )
        )
    )
    assert.ok(
        captured.info.some(
            (message) =>
                !message.includes('记忆查询') &&
                !message.includes('matched content')
        )
    )
})

it('does not read recalled memory content for logging', async () => {
    let contentRead = false
    let hydrated = false
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 1 },
        {
            createFailedJob: createJobStore().createFailedJob,
            upsertSnapshot: async () => {}
        },
        { resolve: async () => createRecallQueryResult() },
        {
            retrieve: async () => [
                {
                    id: 'memory-1',
                    get content() {
                        contentRead = true
                        return 'matched content'
                    },
                    score: 0.9
                }
            ]
        },
        { run: async () => createAgenticTrace('unused') },
        {
            hydrate: async () => {
                hydrated = true
                return ''
            }
        },
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => hydrated, 'embedding recall hydration')

    assert.equal(contentRead, false)
})

it('keeps the previous snapshot when embedding recall returns no results', async () => {
    const jobStore = createJobStore()
    let snapshotWrites = 0
    let hydrateCalls = 0
    const captured = createCapturedLogger()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {
                snapshotWrites += 1
            }
        },
        { resolve: async () => createRecallQueryResult() },
        { retrieve: async () => [] },
        { run: async () => createAgenticTrace('unused') },
        {
            hydrate: async () => {
                hydrateCalls += 1
                return ''
            }
        },
        captured.logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('event=recall.snapshot.unchanged')
            ),
        'empty embedding recall'
    )

    assert.equal(snapshotWrites, 0)
    assert.equal(hydrateCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('completes agentic recall without persisting a successful job', async () => {
    const jobStore = createJobStore()
    const snapshots: MemorySnapshotItem[][] = []
    const repository: RecallWorkflowRepository = {
        createFailedJob: jobStore.createFailedJob,
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
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => snapshots.length === 1, 'agentic recall snapshot')

    const snapshot = snapshots[0]
    assert.ok(snapshot)
    const item = snapshot[0]
    assert.ok(item)
    assert.ok('finalText' in item)
    assert.equal(item.finalText, 'remembered context')
})

it('keeps the previous snapshot without persisting a job for <NO_MEMORY>', async () => {
    const jobStore = createJobStore()
    let snapshotWrites = 0
    const captured = createCapturedLogger()
    const repository: RecallWorkflowRepository = {
        createFailedJob: jobStore.createFailedJob,
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
        captured.logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('event=recall.snapshot.unchanged')
            ),
        'agentic no-memory result'
    )

    assert.equal(snapshotWrites, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('serializes recall runs for the same scope without persisted running state', async () => {
    const jobStore = createJobStore()
    let resolveQuery: ((result: RecallQueryResult) => void) | undefined
    let queryCalls = 0
    const captured = createCapturedLogger()
    const queryResult = new Promise<RecallQueryResult>((resolve) => {
        resolveQuery = resolve
    })
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
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
        captured.logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await coordinator.queue(scope, currentMessage, async () => [])
    assert.equal(queryCalls, 1)

    assert.ok(resolveQuery)
    resolveQuery(createRecallQueryResult())
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('event=recall.snapshot.unchanged')
            ),
        'serialized recall completion'
    )

    assert.equal(jobStore.jobs.length, 0)
})

it('persists one failed recall job when query construction throws', async () => {
    const jobStore = createJobStore()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {}
        },
        {
            resolve: async () => {
                throw new Error('query failure')
            }
        },
        { retrieve: async () => [] },
        { run: async () => createAgenticTrace('unused') },
        { hydrate: async () => '' },
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed recall query')

    assert.equal(jobStore.jobs[0]?.status, 'failed')
    assert.equal(jobStore.jobs[0]?.input, '记忆查询')
    assert.equal(jobStore.jobs[0]?.recallStrategy, 'embedding-rerank')
    assert.match(jobStore.jobs[0]?.error ?? '', /query failure/u)
})

it('logs recall scope and preserves the original background error', async () => {
    const backgroundError = new Error('failed to persist recall failure')
    const captured = createCapturedLogger()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: async () => {
                throw backgroundError
            },
            upsertSnapshot: async () => {}
        },
        {
            resolve: async () => {
                throw new Error('query failure')
            }
        },
        { retrieve: async () => [] },
        { run: async () => createAgenticTrace('unused') },
        { hydrate: async () => '' },
        captured.logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () => captured.warnings.length === 1,
        'recall background warning'
    )

    assert.match(
        String(captured.warnings[0]?.[0]),
        /event=recall.failed workflow=recall .*presetId=preset-1.*conversationId=conversation-1/u
    )
    assert.equal(captured.warnings[0]?.[1], backgroundError)
})

it('persists one failed recall job when retrieval throws', async () => {
    const jobStore = createJobStore()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
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
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed recall retrieval')

    const job = jobStore.jobs[0]
    assert.equal(job?.status, 'failed')
    assert.equal(job?.recallStrategy, 'embedding-rerank')
    assert.equal(+job!.createdAt, +job!.startedAt!)
    assert.ok(+job!.finishedAt! >= +job!.startedAt!)
    assert.match(job?.error ?? '', /retrieval failure/u)
})

it('persists one failed recall job when snapshot hydration throws', async () => {
    const jobStore = createJobStore()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {}
        },
        { resolve: async () => createRecallQueryResult() },
        {
            retrieve: async () => [
                { id: 'memory-1', content: 'matched content', score: 0.9 }
            ]
        },
        { run: async () => createAgenticTrace('unused') },
        {
            hydrate: async () => {
                throw new Error('hydrate failure')
            }
        },
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed snapshot hydration')

    assert.match(jobStore.jobs[0]?.error ?? '', /hydrate failure/u)
})

it('does not persist a recall job when the query is skipped', async () => {
    const jobStore = createJobStore()
    let queryCalls = 0
    let retrieverCalls = 0
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
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
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => queryCalls === 1, 'skipped recall query')

    assert.equal(jobStore.jobs.length, 0)
    assert.equal(retrieverCalls, 0)
})

it('does not persist a recall job when the final query is empty', async () => {
    const jobStore = createJobStore()
    let retrieverCalls = 0
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {}
        },
        {
            resolve: async () =>
                createRecallQueryResult('', {
                    cleanedQuery: 'cleaned query',
                    skippedReason: null
                })
        },
        {
            retrieve: async () => {
                retrieverCalls += 1
                return []
            }
        },
        { run: async () => createAgenticTrace('unused') },
        { hydrate: async () => '' },
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(retrieverCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('continues recall with empty history without persisting a job', async () => {
    const jobStore = createJobStore()
    let receivedHistory: LivingMemoryTranscriptMessage[] | undefined
    let hydrated = 0
    const captured = createCapturedLogger()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'embedding-rerank', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {}
        },
        {
            resolve: async (_scope, _message, historyMessages) => {
                receivedHistory = historyMessages
                return createRecallQueryResult()
            }
        },
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
        captured.logger
    )

    await coordinator.queue(scope, currentMessage, async () => {
        throw new Error('private history failure detail')
    })
    await waitFor(() => hydrated === 1, 'recall after history failure')

    assert.deepEqual(receivedHistory, [])
    assert.equal(jobStore.jobs.length, 0)
    assert.ok(
        captured.info.some(
            (message) => !message.includes('private history failure detail')
        )
    )
})

it('persists one failed agentic recall job when its executor throws', async () => {
    const jobStore = createJobStore()
    const coordinator = new LivingMemoryRecallCoordinator(
        { recallStrategy: 'agentic-recall', recallTopK: 3 },
        {
            createFailedJob: jobStore.createFailedJob,
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
        logger
    )

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed agentic recall')

    assert.equal(jobStore.jobs[0]?.recallStrategy, 'agentic-recall')
    assert.match(jobStore.jobs[0]?.error ?? '', /agentic failure/u)
})
