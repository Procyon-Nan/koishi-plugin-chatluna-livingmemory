import assert from 'node:assert/strict'
import type {
    AgenticMemorySnapshotItem,
    LivingMemoryTranscriptMessage
} from '../src/contracts/memory'
import type { LivingMemoryAgenticRecallTrace } from '../src/service/workflows/recall/agentic_recall'
import {
    LivingMemoryRecallCoordinator,
    type RecallWorkflowRepository
} from '../src/service/workflows/recall/coordinator'
import type { LivingMemoryLogger } from '../src/service/logging/logger'
import {
    createAgenticTrace,
    createCapturedLogger,
    createJobStore,
    currentMessage,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'

type AgenticRun = (
    historyMessages: LivingMemoryTranscriptMessage[],
    runLogger: LivingMemoryLogger
) => Promise<LivingMemoryAgenticRecallTrace | null>

const defaultRun: AgenticRun = async () => createAgenticTrace('记得')

const createCoordinator = (options: {
    repository?: Partial<RecallWorkflowRepository>
    run?: AgenticRun
    hydrate?: () => Promise<string>
    tailSeq?: () => number
    recallIntervalMessages?: number
    subModel?: string
    logger?: LivingMemoryLogger
}) => {
    const run = options.run ?? defaultRun
    return new LivingMemoryRecallCoordinator(
        {
            recallIntervalMessages: options.recallIntervalMessages ?? 1,
            subModel: options.subModel ?? 'test/sub-model'
        },
        { tailSeq: options.tailSeq ?? (() => 100) },
        {
            createFailedJob: createJobStore().createFailedJob,
            upsertSnapshot: async () => {},
            ...options.repository
        },
        {
            run: async (
                _scope,
                _message,
                historyMessages,
                runLogger = logger
            ) => await run(historyMessages, runLogger)
        },
        { hydrate: options.hydrate ?? (async () => '') },
        options.logger ?? logger
    )
}

it('persists the agentic snapshot without persisting a successful job', async () => {
    const jobStore = createJobStore()
    const snapshots: { query: string; items: AgenticMemorySnapshotItem[] }[] =
        []
    let hydrated = 0
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async (_scope, query, items) => {
                snapshots.push({ query, items })
            }
        },
        run: async (_history, runLogger) => {
            runLogger.diagnostic('test.agentic.context')
            return createAgenticTrace('remembered context')
        },
        hydrate: async () => {
            hydrated += 1
            return 'first memory\nsecond memory'
        },
        logger: captured.logger
    })

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => hydrated === 1, 'agentic recall hydration')

    assert.equal(jobStore.jobs.length, 0)
    assert.equal(snapshots.length, 1)
    const trace = createAgenticTrace('remembered context')!
    assert.equal(snapshots[0].query, JSON.stringify(trace.item.toolCallSummary))
    assert.deepEqual(snapshots[0].items, [trace.item])
    const snapshotLog = captured.info.find((message) =>
        message.includes('event=recall.snapshot.updated')
    )
    assert.match(snapshotLog ?? '', /matched=/u)
    assert.match(
        snapshotLog ?? '',
        /--- snapshot\.content ---\nfirst memory\nsecond memory\n--- end recall\.snapshot\.updated ---$/u
    )
    assert.ok(
        captured.info.some((message) =>
            /event=test.agentic.context workflow=recall runId=[^ ]+ presetId=preset-1 conversationId=conversation-1/u.test(
                message
            )
        )
    )
})

it('keeps the previous snapshot without persisting a job for <NO_MEMORY>', async () => {
    const jobStore = createJobStore()
    let snapshotWrites = 0
    let hydrateCalls = 0
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: jobStore.createFailedJob,
            upsertSnapshot: async () => {
                snapshotWrites += 1
            }
        },
        run: async () => createAgenticTrace(''),
        hydrate: async () => {
            hydrateCalls += 1
            return ''
        },
        logger: captured.logger
    })

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('event=recall.snapshot.unchanged')
            ),
        'agentic no-memory result'
    )

    assert.equal(snapshotWrites, 0)
    assert.equal(hydrateCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('skips recall without persisting a job when the current message is empty', async () => {
    const jobStore = createJobStore()
    let runCalls = 0
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            runCalls += 1
            return createAgenticTrace('unused')
        }
    })

    await coordinator.queue(
        scope,
        { ...currentMessage, contentLines: ['  '] },
        async () => []
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(runCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('skips recall without persisting a job when subModel is not configured', async () => {
    const jobStore = createJobStore()
    let runCalls = 0
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            runCalls += 1
            return createAgenticTrace('unused')
        },
        subModel: '无',
        logger: captured.logger
    })

    await coordinator.queue(scope, currentMessage, async () => [])

    assert.equal(runCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
    assert.ok(
        captured.info.some(
            (message) =>
                message.startsWith('event=recall.skipped ') &&
                message.includes('reason=model-not-configured')
        )
    )
})

it('serializes recall runs for the same scope without persisted running state', async () => {
    const jobStore = createJobStore()
    let resolveRun: ((trace: null) => void) | undefined
    let runCalls = 0
    const captured = createCapturedLogger()
    const pendingRun = new Promise<null>((resolve) => {
        resolveRun = resolve
    })
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            runCalls += 1
            return await pendingRun
        },
        logger: captured.logger
    })

    await coordinator.queue(scope, currentMessage, async () => [])
    await coordinator.queue(scope, currentMessage, async () => [])
    assert.equal(runCalls, 1)

    assert.ok(resolveRun)
    resolveRun(null)
    await waitFor(
        () =>
            captured.info.some((message) =>
                message.includes('event=recall.snapshot.unchanged')
            ),
        'serialized recall completion'
    )

    assert.equal(jobStore.jobs.length, 0)
})

it('persists one failed recall job when the agentic executor throws', async () => {
    const jobStore = createJobStore()
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async () => {
            throw new Error('agentic failure')
        }
    })

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed agentic recall')

    const job = jobStore.jobs[0]
    assert.equal(job?.status, 'failed')
    assert.equal(job?.input, '记忆查询')
    assert.equal(+job!.createdAt, +job!.startedAt!)
    assert.ok(+job!.finishedAt! >= +job!.startedAt!)
    assert.match(job?.error ?? '', /agentic failure/u)
})

it('persists one failed recall job when snapshot hydration throws', async () => {
    const jobStore = createJobStore()
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        hydrate: async () => {
            throw new Error('hydrate failure')
        }
    })

    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => jobStore.jobs.length === 1, 'failed snapshot hydration')

    assert.match(jobStore.jobs[0]?.error ?? '', /hydrate failure/u)
})

it('logs recall scope and preserves the original background error', async () => {
    const backgroundError = new Error('failed to persist recall failure')
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: {
            createFailedJob: async () => {
                throw backgroundError
            }
        },
        run: async () => {
            throw new Error('agentic failure')
        },
        logger: captured.logger
    })

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

it('continues recall with empty history without persisting a job', async () => {
    const jobStore = createJobStore()
    let receivedHistory: LivingMemoryTranscriptMessage[] | undefined
    let hydrated = 0
    const captured = createCapturedLogger()
    const coordinator = createCoordinator({
        repository: { createFailedJob: jobStore.createFailedJob },
        run: async (historyMessages) => {
            receivedHistory = historyMessages
            return createAgenticTrace('remembered context')
        },
        hydrate: async () => {
            hydrated += 1
            return ''
        },
        logger: captured.logger
    })

    await coordinator.queue(scope, currentMessage, async () => {
        throw new Error('private history failure detail')
    })
    await waitFor(() => hydrated === 1, 'recall after history failure')

    assert.deepEqual(receivedHistory, [])
    assert.equal(jobStore.jobs.length, 0)
    assert.ok(
        captured.info.every(
            (message) => !message.includes('private history failure detail')
        )
    )
})

it('gates recall by message gap since the last executed recall', async () => {
    const snapshots: number[] = []
    let tail = 100
    const coordinator = createCoordinator({
        repository: {
            upsertSnapshot: async () => {
                snapshots.push(1)
            }
        },
        tailSeq: () => tail,
        recallIntervalMessages: 10
    })

    // 首启无锚点：立即召回
    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => snapshots.length === 1, 'first immediate recall')

    // 间隔不足：跳过
    tail = 105
    await coordinator.queue(scope, currentMessage, async () => [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(snapshots.length, 1)

    // 达到间隔：再次执行并前移锚点
    tail = 110
    await coordinator.queue(scope, currentMessage, async () => [])
    await waitFor(() => snapshots.length === 2, 'second recall after gap')

    // 锚点已前移到 110：新一轮间隔从上次执行点重新计
    tail = 115
    await coordinator.queue(scope, currentMessage, async () => [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(snapshots.length, 2)
})
