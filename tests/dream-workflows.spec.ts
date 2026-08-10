import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import type { DreamMemoryRepository } from '../src/contracts/workflows'
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
import { LivingMemoryDreamJobRunner } from '../src/service/workflows/dream/job_runner'
import type { DreamHdbscanRunner } from '../src/service/workflows/dream/hdbscan/protocol'
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
    countPendingEntries: DreamCoordinatorRepository['countPendingEntries'] = async () =>
        0
): DreamCoordinatorRepository => ({
    createJob: jobStore.createJob,
    markStaleRunningJobsAsFailed: jobStore.markStaleRunningJobsAsFailed,
    countPendingEntries
})

const createIncrementalDreamRunResult = () => ({
    ...createDreamRunResult(),
    selectedCount: 0,
    seedCount: 0,
    successfulSeedCount: 0,
    failedSeedCount: 0,
    remainingPendingCount: 0,
    failed: false
})

const incrementalDream = {
    run: async () => createIncrementalDreamRunResult()
}

const hdbscan: DreamHdbscanRunner = {
    run: async ({ entryCount }) => new Int32Array(entryCount)
}

type DreamCoordinatorArgs = ConstructorParameters<
    typeof LivingMemoryDreamCoordinator
>
type DreamJobRunnerArgs = ConstructorParameters<
    typeof LivingMemoryDreamJobRunner
>

const createDreamCoordinator = (
    config: DreamCoordinatorArgs[0],
    dream: DreamJobRunnerArgs[0],
    incremental: DreamJobRunnerArgs[1],
    repository: DreamCoordinatorArgs[2],
    snapshotCache: DreamJobRunnerArgs[2],
    jobTracker: DreamJobRunnerArgs[3],
    targetLogger: DreamCoordinatorArgs[3],
    targetDebug: DreamCoordinatorArgs[4]
) =>
    new LivingMemoryDreamCoordinator(
        config,
        new LivingMemoryDreamJobRunner(
            dream,
            incremental,
            snapshotCache,
            jobTracker,
            targetDebug
        ),
        repository,
        targetLogger,
        targetDebug
    )

const createDreamServiceHarness = (enableUserProfileInjection: boolean) => {
    const events: string[] = []
    const debugMessages: string[] = []
    const consolidatedIds: string[] = []
    const activeEntry = {
        ...createMemoryEntry('active-memory'),
        keywords: ['张三']
    }
    const archivedEntry = createMemoryEntry('archived-memory', 'archived')
    const entries = [activeEntry, archivedEntry]
    let presetRenderCount = 0
    const repository = {
        listDreamEntriesByPreset: async () => {
            events.push('list-entries')
            return entries
        },
        updateMemoryForDream: async () => {},
        setMemoryConsolidation: async (
            _presetId: string,
            ids: string[],
            isConsolidated: boolean
        ) => {
            if (isConsolidated) {
                consolidatedIds.push(...ids)
            }
        },
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
                    return { value: {} }
                }
            },
            promptRenderer: {
                renderPresetTemplate: async () => {
                    presetRenderCount++
                    if (presetRenderCount === 1) {
                        return { messages: [] }
                    }
                    throw new Error('preset prompt rendering failure')
                }
            }
        }
    } as unknown as Context
    const service = new LivingMemoryDreamService(
        ctx,
        {
            mainModel: 'dream-model',
            debug: false,
            enableUserProfileInjection,
            userProfileMemoryLimit: 20
        },
        repository as unknown as DreamRepository,
        repository as unknown as DreamMemoryRepository,
        {
            readVectors: async () => new Map()
        },
        hdbscan,
        (message) => debugMessages.push(message)
    )

    return { consolidatedIds, debugMessages, events, service }
}

it('keeps Dream successful when post-Dream user profile generation fails', async () => {
    const harness = createDreamServiceHarness(true)

    const result = await harness.service.run(scope.presetId)

    assert.match(
        result.detail,
        /user profiles failed: preset prompt rendering failure/u
    )
    assert.deepEqual(harness.events, [
        'list-entries',
        'create-model',
        'resolve-preset',
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
    assert.deepEqual(harness.consolidatedIds, [
        'active-memory',
        'archived-memory'
    ])
})

it('does not start post-Dream user profile generation when disabled', async () => {
    const harness = createDreamServiceHarness(false)

    const result = await harness.service.run(scope.presetId)

    assert.match(result.detail, /user profiles skipped: disabled/u)
    assert.deepEqual(harness.events, [
        'list-entries',
        'create-model',
        'resolve-preset',
        'list-entries'
    ])
})

it('marks a single-memory manual Dream as consolidated', async () => {
    const entry = createMemoryEntry('only-memory')
    const consolidatedIds: string[] = []
    const repository = {
        listDreamEntriesByPreset: async () => [entry],
        setMemoryConsolidation: async (_presetId: string, ids: string[]) => {
            consolidatedIds.push(...ids)
        }
    } as unknown as DreamRepository
    const service = new LivingMemoryDreamService(
        {} as Context,
        {
            mainModel: 'dream-model',
            debug: false,
            enableUserProfileInjection: false,
            userProfileMemoryLimit: 20
        },
        repository as unknown as DreamRepository,
        repository as unknown as DreamMemoryRepository,
        {
            readVectors: async () => new Map()
        },
        hdbscan,
        () => {}
    )

    const result = await service.run(scope.presetId)

    assert.equal(result.entryCount, 1)
    assert.deepEqual(consolidatedIds, [entry.id])
})

it('locks a Dream preset while its job is running', async () => {
    const jobStore = createJobStore()
    let dreamCalls = 0
    let resolveDream!: (result: DreamRunResult) => void
    const dreamResult = new Promise<DreamRunResult>((resolve) => {
        resolveDream = resolve
    })
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 1
        },
        {
            run: async () => {
                dreamCalls += 1
                return await dreamResult
            }
        },
        incrementalDream,
        createDreamCoordinatorRepository(jobStore),
        { clearByPreset: () => {} },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    const first = await coordinator.runManual(scope.presetId)
    const second = await coordinator.runManual(scope.presetId)

    assert.equal(first.started, true)
    assert.equal(second.started, false)
    assert.equal(second.reason, 'preset-locked')
    assert.equal(jobStore.jobs[0]?.status, 'running')

    resolveDream(createDreamRunResult())
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'Dream completion'
    )
    assert.equal(dreamCalls, 1)
})

const completeDreamUpdateOperation = (): Extract<
    DreamOperation,
    { action: 'update' }
> => ({
    action: 'update',
    memoryId: 'memory-1',
    memory: {
        type: 'fact',
        content: 'updated content',
        summary: 'updated summary',
        keywords: ['updated'],
        sentiment: 'neutral',
        importance: 0.8
    },
    reason: 'test update'
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
    },
    reason: 'test merge'
})

it('enforces Dream touched-memory guards', async () => {
    const updates: Partial<MemoryEntryRecord>[] = []
    const repository = {
        updateMemoryForDream: async (_presetId, _id, patch) => {
            updates.push(patch)
        },
        setMemoryConsolidation: async () => {},
        applyDreamMerge: async () => {}
    } as unknown as DreamExecutorRepository
    const executor = new DreamExecutor(repository, () => {})
    const entry = createMemoryEntry('memory-1')
    const cluster = { id: 'cluster-1', reason: 'test', entries: [entry] }

    const touchedMemoryIds = new Set<string>()
    const repeatedUpdate = await executor.executeOperations(
        'active',
        cluster,
        [completeDreamUpdateOperation(), completeDreamUpdateOperation()],
        touchedMemoryIds,
        'manual'
    )

    assert.equal(repeatedUpdate.updated, 1)
    assert.equal(repeatedUpdate.skipped, 1)
    assert.equal(updates.length, 1)
})

it('delegates each Dream merge to one atomic repository operation', async () => {
    const mergeInputs: Parameters<
        DreamExecutorRepository['applyDreamMerge']
    >[0][] = []
    const repository = {
        updateMemoryForDream: async () => {},
        setMemoryConsolidation: async () => {},
        applyDreamMerge: async (input) => {
            mergeInputs.push(input)
        }
    } as unknown as DreamExecutorRepository
    const executor = new DreamExecutor(repository, () => {})
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
        activeTouched,
        'manual'
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
        archivedTouched,
        'manual'
    )

    assert.equal(mergeInputs.length, 2)
    assert.equal(mergeInputs[0]?.sourceDisposition, 'archive')
    assert.deepEqual(
        mergeInputs[0]?.sources.map((source) => source.id),
        ['source-active-1', 'source-active-2']
    )
    assert.equal(mergeInputs[0]?.patch.status, 'active')
    assert.equal(mergeInputs[1]?.sourceDisposition, 'delete')
    assert.equal(mergeInputs[1]?.patch.status, 'archived')
    const {
        consolidatedMemoryIds: _activeConsolidated,
        mutatedMemoryIds: _activeMutated,
        ...activeStats
    } = activeResult
    const {
        consolidatedMemoryIds: _archivedConsolidated,
        mutatedMemoryIds: _archivedMutated,
        ...archivedStats
    } = archivedResult
    assert.deepEqual(activeStats, {
        kept: 0,
        merged: 1,
        updated: 0,
        archived: 2,
        deleted: 0,
        skipped: 0
    })
    assert.deepEqual(archivedStats, {
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
    const repository = {
        updateMemoryForDream: async () => {},
        setMemoryConsolidation: async () => {},
        applyDreamMerge: async () => {
            throw new Error('merge write failed')
        }
    } as unknown as DreamExecutorRepository
    const executor = new DreamExecutor(repository, () => {})
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
            touchedMemoryIds,
            'manual'
        ),
        /merge write failed/u
    )
    assert.deepEqual([...touchedMemoryIds], ['already-touched'])
})

it('skips auto Dream when pending memories are below the threshold', async () => {
    const jobStore = createJobStore()
    let dreamCalls = 0
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: true,
            autoDreamMemoryGrowthThreshold: 3
        },
        {
            run: async () => {
                dreamCalls += 1
                return createDreamRunResult()
            }
        },
        incrementalDream,
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

it('runs one incremental Dream batch when pending memories reach the threshold', async () => {
    const jobStore = createJobStore()
    let incrementalCalls = 0
    const debugMessages: string[] = []
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: true,
            autoDreamMemoryGrowthThreshold: 3
        },
        {
            run: async () => {
                return createDreamRunResult()
            }
        },
        {
            run: async () => {
                incrementalCalls += 1
                return createIncrementalDreamRunResult()
            }
        },
        createDreamCoordinatorRepository(jobStore, async () => 3),
        { clearByPreset: () => {} },
        new LivingMemoryJobTracker(jobStore),
        logger,
        (buildMessage) => debugMessages.push(buildMessage())
    )

    await coordinator.queueAutoIfThresholdReached(scope.presetId)

    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'automatic Dream completion'
    )
    assert.equal(incrementalCalls, 1)
    assert.equal(jobStore.jobs.length, 1)
    assert.ok(
        debugMessages.some((message) =>
            message.includes('memory auto dream threshold reached')
        )
    )
})

it('records partial incremental Dream failures in the job detail', async () => {
    const jobStore = createJobStore()
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: true,
            autoDreamMemoryGrowthThreshold: 3
        },
        { run: async () => createDreamRunResult() },
        {
            run: async () => ({
                ...createIncrementalDreamRunResult(),
                failed: true,
                failedSeedCount: 1,
                remainingPendingCount: 1,
                detail: 'seed failed after structured-output retries'
            })
        },
        createDreamCoordinatorRepository(jobStore, async () => 3),
        { clearByPreset: () => {} },
        new LivingMemoryJobTracker(jobStore),
        logger,
        debug
    )

    await coordinator.queueAutoIfThresholdReached(scope.presetId)
    await waitFor(
        () => jobStore.jobs[0]?.status === 'failed',
        'automatic Dream failure'
    )

    assert.equal(
        jobStore.jobs[0]?.detail,
        'seed failed after structured-output retries'
    )
    assert.equal(jobStore.jobs[0]?.error, 'automatic incremental dream failed')
})

it('logs Dream job context and preserves the original background error', async () => {
    const jobStore = createJobStore()
    const backgroundError = new Error('manual Dream failed')
    const warnings: unknown[][] = []
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 3
        },
        {
            run: async () => {
                throw backgroundError
            }
        },
        incrementalDream,
        createDreamCoordinatorRepository(jobStore),
        { clearByPreset: () => {} },
        new LivingMemoryJobTracker(jobStore),
        { warn: (...args) => warnings.push(args) },
        debug
    )

    await coordinator.runManual(scope.presetId)
    await waitFor(() => warnings.length === 1, 'Dream background warning')

    assert.match(
        String(warnings[0]?.[0]),
        /workflow=dream operation=run-job conversationId=dream:manual:preset-1 presetId=preset-1 jobId=job-1 trigger=manual/u
    )
    assert.equal(warnings[0]?.[1], backgroundError)
})

it('clears snapshot cache only when successful Dream changes memories', async () => {
    const runDream = async (result: DreamRunResult) => {
        const jobStore = createJobStore()
        const clearedPresets: string[] = []
        const coordinator = createDreamCoordinator(
            {
                enableAutoDream: false,
                autoDreamMemoryGrowthThreshold: 3
            },
            { run: async () => result },
            incrementalDream,
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

        await coordinator.runManual(scope.presetId)
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
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 3
        },
        {
            run: async () => {
                throw new Error('dream failed')
            }
        },
        incrementalDream,
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

    await coordinator.runManual(scope.presetId)
    await waitFor(() => jobStore.jobs[0]?.status === 'failed', 'Dream failure')

    assert.deepEqual(clearedPresets, [scope.presetId])
})
