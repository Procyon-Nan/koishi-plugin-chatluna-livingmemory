import assert from 'node:assert/strict'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import {
    type DreamCoordinatorRepository,
    LivingMemoryDreamCoordinator
} from '../src/service/workflows/dream/coordinator'
import {
    DreamExecutor,
    type DreamExecutorRepository
} from '../src/service/workflows/dream/executor'
import type {
    DreamOperation,
    DreamRunResult
} from '../src/service/workflows/dream/types'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker'
import {
    createDreamRunResult,
    createJobStore,
    createMemoryEntry,
    debug,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'

const createDreamCoordinatorRepository = (
    jobStore: ReturnType<typeof createJobStore>,
    countEntriesCreatedAfter: DreamCoordinatorRepository['countEntriesCreatedAfter'] = async () =>
        0
): DreamCoordinatorRepository => ({
    createJob: jobStore.createJob,
    getLatestJobByPresetAndKind: jobStore.getLatestJobByPresetAndKind,
    markStaleRunningJobsAsFailed: jobStore.markStaleRunningJobsAsFailed,
    countEntriesCreatedAfter
})

it('locks a Dream preset while its job is running', async () => {
    const jobStore = createJobStore()
    let resolveDream!: (result: DreamRunResult) => void
    const dreamResult = new Promise<DreamRunResult>((resolve) => {
        resolveDream = resolve
    })
    const coordinator = new LivingMemoryDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 1,
            dreamModel: 'dream-model'
        },
        { run: async () => await dreamResult },
        createDreamCoordinatorRepository(jobStore),
        { clearByPreset: () => {} },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    const first = await coordinator.run(scope.presetId)
    const second = await coordinator.run(scope.presetId)

    assert.equal(first.started, true)
    assert.equal(second.started, false)
    assert.equal(second.reason, 'preset-locked')
    assert.equal(jobStore.jobs[0]?.status, 'running')

    resolveDream(createDreamRunResult())
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'Dream completion'
    )
})

const completeDreamOperation = (
    action: DreamOperation['action']
): DreamOperation => ({
    action,
    memoryId: 'memory-1',
    memory: {
        type: 'fact',
        content: 'updated content',
        summary: 'updated summary',
        keywords: ['updated'],
        sentiment: 'neutral',
        importance: 0.8
    }
})

it('enforces Dream stage actions and touched-memory guards', async () => {
    const updates: Partial<MemoryEntryRecord>[] = []
    const repository: DreamExecutorRepository = {
        deleteMemory: async () => {},
        updateMemory: async (_id, patch) => {
            updates.push(patch)
        },
        updateMemorySourceOrigins: async () => {}
    }
    const executor = new DreamExecutor(repository)
    const entry = createMemoryEntry('memory-1')
    const cluster = { id: 'cluster-1', reason: 'test', entries: [entry] }

    const activeDeleteSource = await executor.executeOperations(
        'active',
        cluster,
        [{ action: 'deleteSource', sourceMemoryIds: [entry.id] }],
        new Set()
    )
    const archivedArchive = await executor.executeOperations(
        'archived',
        { ...cluster, entries: [createMemoryEntry('memory-1', 'archived')] },
        [{ action: 'archive', memoryId: entry.id }],
        new Set()
    )
    const touchedMemoryIds = new Set<string>()
    const repeatedUpdate = await executor.executeOperations(
        'active',
        cluster,
        [completeDreamOperation('update'), completeDreamOperation('update')],
        touchedMemoryIds
    )

    assert.equal(activeDeleteSource.skipped, 1)
    assert.equal(archivedArchive.skipped, 1)
    assert.equal(repeatedUpdate.updated, 1)
    assert.equal(repeatedUpdate.skipped, 1)
    assert.equal(updates.length, 1)
})

it('skips auto Dream when memory growth is below the threshold', async () => {
    const jobStore = createJobStore()
    let dreamCalls = 0
    const coordinator = new LivingMemoryDreamCoordinator(
        {
            enableAutoDream: true,
            autoDreamMemoryGrowthThreshold: 3,
            dreamModel: 'dream-model'
        },
        {
            run: async () => {
                dreamCalls += 1
                return createDreamRunResult()
            }
        },
        createDreamCoordinatorRepository(jobStore, async () => 2),
        { clearByPreset: () => {} },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queueAutoIfThresholdReached(scope.presetId)

    assert.equal(dreamCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('starts auto Dream when memory growth reaches the threshold', async () => {
    const jobStore = createJobStore()
    let countCalls = 0
    let dreamCalls = 0
    const coordinator = new LivingMemoryDreamCoordinator(
        {
            enableAutoDream: true,
            autoDreamMemoryGrowthThreshold: 3,
            dreamModel: 'dream-model'
        },
        {
            run: async () => {
                dreamCalls += 1
                return createDreamRunResult()
            }
        },
        createDreamCoordinatorRepository(jobStore, async () => {
            countCalls += 1
            return countCalls === 1 ? 3 : 0
        }),
        { clearByPreset: () => {} },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queueAutoIfThresholdReached(scope.presetId)
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'automatic Dream completion'
    )

    assert.equal(dreamCalls, 1)
    assert.equal(jobStore.jobs.length, 1)
})

it('clears snapshot cache only when Dream changes memories', async () => {
    const runDream = async (result: DreamRunResult) => {
        const jobStore = createJobStore()
        const clearedPresets: string[] = []
        const coordinator = new LivingMemoryDreamCoordinator(
            {
                enableAutoDream: false,
                autoDreamMemoryGrowthThreshold: 3,
                dreamModel: 'dream-model'
            },
            { run: async () => result },
            createDreamCoordinatorRepository(jobStore),
            {
                clearByPreset: (presetId) => {
                    clearedPresets.push(presetId)
                }
            },
            new LivingMemoryJobTracker(jobStore),
            logger,
            debug
        )

        await coordinator.run(scope.presetId)
        await waitFor(
            () => jobStore.jobs[0]?.status === 'completed',
            'Dream cache decision'
        )
        return clearedPresets
    }

    const unchanged = await runDream(createDreamRunResult())
    const changed = await runDream({
        ...createDreamRunResult(),
        merged: 1
    })

    assert.deepEqual(unchanged, [])
    assert.deepEqual(changed, [scope.presetId])
})
