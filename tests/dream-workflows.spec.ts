import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import {
    type DreamRepository,
    LivingMemoryDreamService
} from '../src/service/workflows/dream'
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

const createDreamServiceHarness = (enableUserProfileInjection: boolean) => {
    const events: string[] = []
    const debugMessages: string[] = []
    const activeEntry = {
        ...createMemoryEntry('active-memory'),
        keywords: ['张三']
    }
    const archivedEntry = createMemoryEntry('archived-memory', 'archived')
    const entries = [activeEntry, archivedEntry]
    const repository: DreamRepository = {
        listEntriesByPreset: async () => {
            events.push('list-entries')
            return entries
        },
        updateEntryEmbeddings: async () => {},
        updateMemory: async () => {},
        applyDreamMerge: async () => {},
        listPresetSpeakers: async () => {
            events.push('list-speakers')
            return [
                {
                    id: 'speaker-1',
                    presetId: scope.presetId,
                    speakerKey: '张三',
                    speakerLabel: '张三',
                    speakerId: 'user-1',
                    createdAt: activeEntry.createdAt,
                    updatedAt: activeEntry.updatedAt
                }
            ]
        },
        upsertPresetSpeaker: async () => {},
        listUserProfilesByPreset: async () => {
            events.push('list-profiles')
            return []
        },
        listUserProfilesBySpeakerKeys: async () => [],
        replaceUserProfile: async () => {},
        deleteUserProfile: async () => {}
    }
    const ctx = {
        chatluna: {
            createChatModel: async () => {
                events.push('create-model')
                return {
                    value: {
                        invoke: async () => ({ content: '[]' })
                    }
                }
            },
            preset: {
                getPreset: () => {
                    events.push('resolve-preset')
                    return { value: null }
                }
            }
        }
    } as unknown as Context
    const service = new LivingMemoryDreamService(
        ctx,
        {
            dreamModel: 'dream-model',
            embeddingModel: 'embedding-model',
            enableUserProfileInjection,
            userProfileMemoryLimit: 20
        },
        repository,
        (message) => debugMessages.push(message)
    )

    return { debugMessages, events, service }
}

it('keeps Dream successful when post-Dream user profile generation fails', async () => {
    const harness = createDreamServiceHarness(true)

    const result = await harness.service.run(scope.presetId)

    assert.match(
        result.detail,
        /user profiles failed: memory user profile preset prompt unavailable/u
    )
    assert.deepEqual(harness.events, [
        'list-entries',
        'create-model',
        'list-entries',
        'list-entries',
        'list-speakers',
        'list-profiles',
        'resolve-preset'
    ])
    assert.ok(
        harness.debugMessages.some((message) =>
            message.includes('user profile generation failed after dream')
        )
    )
})

it('does not start post-Dream user profile generation when disabled', async () => {
    const harness = createDreamServiceHarness(false)

    const result = await harness.service.run(scope.presetId)

    assert.match(result.detail, /user profiles skipped: disabled/u)
    assert.deepEqual(harness.events, [
        'list-entries',
        'create-model',
        'list-entries'
    ])
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

const completeDreamMergeOperation = (
    targetMemoryId: string,
    sourceMemoryIds: string[]
): DreamOperation => ({
    action: 'merge',
    targetMemoryId,
    sourceMemoryIds,
    memory: {
        type: 'fact',
        content: 'merged content',
        summary: 'merged summary',
        keywords: ['merged'],
        sentiment: 'neutral',
        importance: 0.9
    }
})

it('enforces Dream stage actions and touched-memory guards', async () => {
    const updates: Partial<MemoryEntryRecord>[] = []
    const repository: DreamExecutorRepository = {
        updateMemory: async (_id, patch) => {
            updates.push(patch)
        },
        applyDreamMerge: async () => {}
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

it('delegates each Dream merge to one atomic repository operation', async () => {
    const mergeInputs: Parameters<
        DreamExecutorRepository['applyDreamMerge']
    >[0][] = []
    const repository: DreamExecutorRepository = {
        updateMemory: async () => {},
        applyDreamMerge: async (input) => {
            mergeInputs.push(input)
        }
    }
    const executor = new DreamExecutor(repository)
    const activeEntries = [
        createMemoryEntry('target-active'),
        createMemoryEntry('source-active-1'),
        createMemoryEntry('source-active-2')
    ]
    const activeTouched = new Set<string>()
    const activeResult = await executor.executeOperations(
        'active',
        { id: 'active-cluster', reason: 'test', entries: activeEntries },
        [
            completeDreamMergeOperation('target-active', [
                'source-active-1',
                'source-active-2'
            ])
        ],
        activeTouched
    )
    const archivedEntries = [
        createMemoryEntry('target-archived', 'archived'),
        createMemoryEntry('source-archived-1', 'archived'),
        createMemoryEntry('source-archived-2', 'archived')
    ]
    const archivedTouched = new Set<string>()
    const archivedResult = await executor.executeOperations(
        'archived',
        {
            id: 'archived-cluster',
            reason: 'test',
            entries: archivedEntries
        },
        [
            completeDreamMergeOperation('target-archived', [
                'source-archived-1',
                'source-archived-2'
            ])
        ],
        archivedTouched
    )

    assert.equal(mergeInputs.length, 2)
    assert.equal(mergeInputs[0]?.sourceDisposition, 'archive')
    assert.deepEqual(
        mergeInputs[0]?.sources.map((source) => source.id),
        [
        'source-active-1',
        'source-active-2'
        ]
    )
    assert.equal(mergeInputs[0]?.patch.status, 'active')
    assert.equal(mergeInputs[1]?.sourceDisposition, 'delete')
    assert.equal(mergeInputs[1]?.patch.status, 'archived')
    assert.deepEqual(activeResult, {
        kept: 0,
        merged: 1,
        updated: 0,
        archived: 2,
        deleted: 0,
        skipped: 0
    })
    assert.deepEqual(archivedResult, {
        kept: 0,
        merged: 1,
        updated: 0,
        archived: 0,
        deleted: 2,
        skipped: 0
    })
    assert.deepEqual([...activeTouched].sort(), [
        'source-active-1',
        'source-active-2',
        'target-active'
    ])
    assert.deepEqual([...archivedTouched].sort(), [
        'source-archived-1',
        'source-archived-2',
        'target-archived'
    ])
})

it('does not touch merge state when the atomic repository write fails', async () => {
    const repository: DreamExecutorRepository = {
        updateMemory: async () => {},
        applyDreamMerge: async () => {
            throw new Error('merge write failed')
        }
    }
    const executor = new DreamExecutor(repository)
    const touchedMemoryIds = new Set(['already-touched'])

    await assert.rejects(
        executor.executeOperations(
            'active',
            {
                id: 'cluster-1',
                reason: 'test',
                entries: [
                    createMemoryEntry('target'),
                    createMemoryEntry('source')
                ]
            },
            [completeDreamMergeOperation('target', ['source'])],
            touchedMemoryIds
        ),
        /merge write failed/u
    )
    assert.deepEqual([...touchedMemoryIds], ['already-touched'])
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

it('clears snapshot cache only when successful Dream changes memories', async () => {
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

it('clears snapshot cache when Dream fails after possible writes', async () => {
    const jobStore = createJobStore()
    const clearedPresets: string[] = []
    const coordinator = new LivingMemoryDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 3,
            dreamModel: 'dream-model'
        },
        {
            run: async () => {
                throw new Error('dream failed')
            }
        },
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
    await waitFor(() => jobStore.jobs[0]?.status === 'failed', 'Dream failure')

    assert.deepEqual(clearedPresets, [scope.presetId])
})
