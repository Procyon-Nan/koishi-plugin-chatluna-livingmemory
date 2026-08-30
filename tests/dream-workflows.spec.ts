import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type {
    MemoryEntryRecord,
    PresetSpeakerRecord
} from '../src/contracts/memory'
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
import { partitionDreamEntries } from '../src/service/workflows/dream/partitioning'
import type { DreamWorkerRunner } from '../src/service/workflows/dream/worker/protocol'
import type {
    DreamOperation,
    DreamRunResult
} from '../src/service/workflows/dream/types'
import { dreamResultToolName } from '../src/service/prompts/schema'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker'
import {
    createDreamRunResult,
    createCapturedLogger,
    createJobStore,
    createMemoryEntry,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'
import {
    createToolCallingModel,
    createToolCallMessage
} from './tool-calling-test-utils'

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

const dreamWorker: DreamWorkerRunner = {
    partition: async (entries) => partitionDreamEntries(entries),
    runHdbscan: async ({ entryCount }) => new Int32Array(entryCount)
}

const dreamSpeakers: PresetSpeakerRecord[] = [
    {
        id: 'speaker-1',
        presetId: scope.presetId,
        speakerKey: 'speaker-key',
        speakerLabel: '张三',
        speakerAliases: ['张三'],
        speakerId: 'user-1',
        platform: 'test',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z')
    }
]

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
    targetLogger: DreamCoordinatorArgs[3]
) =>
    new LivingMemoryDreamCoordinator(
        config,
        new LivingMemoryDreamJobRunner(
            dream,
            incremental,
            snapshotCache,
            jobTracker,
            targetLogger
        ),
        repository,
        targetLogger
    )

const createDreamServiceHarness = (enableUserProfileInjection: boolean) => {
    const events: string[] = []
    const captured = createCapturedLogger()
    const consolidatedIds: string[] = []
    const activeEntry = {
        ...createMemoryEntry('active-memory'),
        speakerKeys: ['张三'],
        keywords: ['张三']
    }
    const archivedEntry = {
        ...createMemoryEntry('archived-memory', 'archived'),
        speakerKeys: ['张三']
    }
    const secondActiveEntry = {
        ...createMemoryEntry('second-active-memory'),
        speakerKeys: ['张三']
    }
    const entries = [activeEntry, secondActiveEntry, archivedEntry]
    const model = createToolCallingModel([
        createToolCallMessage(dreamResultToolName, {
            operations: [
                {
                    action: 'keep',
                    memoryIds: [activeEntry.id, secondActiveEntry.id],
                    reason: '保持独立'
                }
            ]
        })
    ])
    let presetRenderCount = 0
    const repository = {
        listDreamEntriesByPreset: async () => {
            events.push('list-entries')
            return entries.filter((entry) => entry.status === 'active')
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
                    speakerAliases: ['张三'],
                    speakerId: 'user-1',
                    platform: 'test',
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
                return { value: model.model }
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
            enableUserProfileInjection,
            userProfileMemoryLimit: 20
        },
        repository as unknown as DreamRepository,
        repository as unknown as DreamMemoryRepository,
        {
            readVectors: async (_presetId, memoryIds) =>
                new Map(
                    memoryIds.map((id) => [id, new Float32Array([1, 0])])
                )
        },
        dreamWorker,
        captured.logger
    )

    return { consolidatedIds, debugMessages: captured.info, events, service }
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
        'list-speakers',
        'list-entries',
        'list-speakers',
        'list-profiles',
        'resolve-preset'
    ])
    assert.ok(
        harness.debugMessages.some((message) =>
            message.includes('event=dream.user-profile.failed')
        )
    )
    assert.ok(
        harness.debugMessages.every(
            (message) => !message.includes('memory dream execution summary')
        )
    )
    assert.deepEqual(harness.consolidatedIds, [
        'active-memory',
        'second-active-memory'
    ])
})

it('does not start post-Dream user profile generation when disabled', async () => {
    const harness = createDreamServiceHarness(false)

    const result = await harness.service.run(scope.presetId)

    assert.match(result.detail, /user profiles skipped: disabled/u)
    assert.equal(result.entryCount, 2)
    assert.equal(result.clusterCount, 1)
    assert.deepEqual(harness.events, [
        'list-entries',
        'create-model',
        'resolve-preset',
        'list-speakers'
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
            enableUserProfileInjection: false,
            userProfileMemoryLimit: 20
        },
        repository as unknown as DreamRepository,
        repository as unknown as DreamMemoryRepository,
        {
            readVectors: async () => new Map()
        },
        dreamWorker,
        logger
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
    const captured = createCapturedLogger()
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
        captured.logger
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
    assert.equal(
        captured.info.filter((message) =>
            message.includes('event=dream.completed')
        ).length,
        1
    )
})

it('logs manual Dream completion for active memories', async () => {
    const jobStore = createJobStore()
    const captured = createCapturedLogger()
    const clearedPresets: string[] = []
    const result: DreamRunResult = {
        entryCount: 33,
        clusterCount: 6,
        kept: 10,
        merged: 2,
        updated: 0,
        archived: 2,
        skipped: 1,
        detail: 'Dream completed'
    }
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 1
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
        captured.logger
    )

    await coordinator.runManual(scope.presetId)
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'Dream stage completion logs'
    )

    const completionLogs = captured.info.filter((message) =>
        message.includes('event=dream.completed')
    )
    assert.equal(completionLogs.length, 1)
    assert.match(
        completionLogs[0],
        /archived=2.*clusters=6.*entries=33.*kept=10.*merged=2.*skipped=1.*updated=0/u
    )
    assert.doesNotMatch(completionLogs[0], /stage=|deleted=/u)
    assert.deepEqual(clearedPresets, [scope.presetId])
    assert.ok(
        captured.info.every(
            (message) => !message.includes('event=dream.snapshot-cache.cleared')
        )
    )
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
        speakerLabels: ['张三'],
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
        speakerLabels: ['张三'],
        sentiment: 'neutral',
        importance: 0.9
    },
    reason: 'test merge'
})

it('enforces Dream touched-memory guards', async () => {
    const updates: Partial<MemoryEntryRecord>[] = []
    const repository = {
        updateMemoryForDream: async (
            _presetId: string,
            _id: string,
            patch: Parameters<
                DreamExecutorRepository['updateMemoryForDream']
            >[2]
        ) => {
            updates.push(patch)
        },
        setMemoryConsolidation: async () => {},
        applyDreamMerge: async () => {}
    } as unknown as DreamExecutorRepository
    const captured = createCapturedLogger()
    const executor = new DreamExecutor(repository)
    const entry = createMemoryEntry('memory-1')
    const cluster = { id: 'cluster-1', reason: 'test', entries: [entry] }

    const touchedMemoryIds = new Set<string>()
    const repeatedUpdate = await executor.executeOperations(
        scope.presetId,
        cluster,
        [completeDreamUpdateOperation(), completeDreamUpdateOperation()],
        touchedMemoryIds,
        'manual',
        dreamSpeakers,
        captured.logger
    )

    assert.equal(repeatedUpdate.updated, 1)
    assert.equal(repeatedUpdate.skipped, 1)
    assert.equal(updates.length, 1)
    assert.equal(captured.info.length, 1)
    assert.match(captured.info[0], /event=dream.operation.skipped/u)
    assert.match(captured.info[0], /reason=already-touched/u)
})

it('delegates each Dream merge to one atomic repository operation', async () => {
    const mergeInputs: Parameters<
        DreamExecutorRepository['applyDreamMerge']
    >[0][] = []
    const repository = {
        updateMemoryForDream: async () => {},
        setMemoryConsolidation: async () => {},
        applyDreamMerge: async (
            input: Parameters<DreamExecutorRepository['applyDreamMerge']>[0]
        ) => {
            mergeInputs.push(input)
        }
    } as unknown as DreamExecutorRepository
    const executor = new DreamExecutor(repository)
    const activeEntries = [
        createMemoryEntry('target-active'),
        createMemoryEntry('source-active-1'),
        createMemoryEntry('source-active-2')
    ]
    const activeTouched = new Set<string>()
    const activeResult = await executor.executeOperations(
        scope.presetId,
        { id: 'active-cluster', reason: 'test', entries: activeEntries },
        [
            completeDreamMergeOperation('target-active', [
                'source-active-1',
                'source-active-2'
            ])
        ],
        activeTouched,
        'manual',
        dreamSpeakers
    )
    assert.equal(mergeInputs.length, 1)
    assert.deepEqual(
        mergeInputs[0]?.sources.map((source) => source.id),
        ['source-active-1', 'source-active-2']
    )
    const {
        consolidatedMemoryIds: _activeConsolidated,
        mutatedMemoryIds: _activeMutated,
        ...activeStats
    } = activeResult
    assert.deepEqual(activeStats, {
        kept: 0,
        merged: 1,
        updated: 0,
        archived: 2,
        skipped: 0
    })
    assert.deepEqual([...activeTouched].sort(), [
        'source-active-1',
        'source-active-2',
        'target-active'
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
    const executor = new DreamExecutor(repository)
    const touchedMemoryIds = new Set(['already-touched'])

    await assert.rejects(
        executor.executeOperations(
            scope.presetId,
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
            'manual',
            dreamSpeakers
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
        logger
    )

    await coordinator.queueAutoIfThresholdReached(scope.presetId)

    assert.equal(dreamCalls, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('runs one incremental Dream batch when pending memories reach the threshold', async () => {
    const jobStore = createJobStore()
    let incrementalCalls = 0
    const captured = createCapturedLogger()
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
        captured.logger
    )

    await coordinator.queueAutoIfThresholdReached(scope.presetId)

    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'automatic Dream completion'
    )
    assert.equal(incrementalCalls, 1)
    assert.equal(jobStore.jobs.length, 1)
    const completionLogs = captured.info.filter((message) =>
        message.includes('event=dream.completed')
    )
    assert.equal(completionLogs.length, 1)
    assert.ok(!completionLogs[0]?.includes('stage='))
    assert.ok(
        captured.info.some((message) =>
            message.includes('event=dream.automatic.threshold-reached')
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
        logger
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

it('preserves the automatic Dream failure when failed-state persistence is retried', async () => {
    const jobStore = createJobStore()
    const stateError = new Error('first mark failed attempt failed')
    const captured = createCapturedLogger()
    let markFailedCalls = 0
    let persistedFailure: unknown
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
                detail: 'incremental Dream failed'
            })
        },
        createDreamCoordinatorRepository(jobStore, async () => 3),
        { clearByPreset: () => {} },
        {
            markRunning: async () => {},
            markCompleted: async () => {},
            markFailed: async (_jobId, error) => {
                markFailedCalls += 1
                if (markFailedCalls === 1) {
                    throw stateError
                }
                persistedFailure = error
            }
        },
        captured.logger
    )

    await coordinator.queueAutoIfThresholdReached(scope.presetId)
    await waitFor(
        () => captured.warnings.length === 1,
        'automatic Dream failed-state retry'
    )

    assert.equal(markFailedCalls, 2)
    assert.equal(persistedFailure, 'automatic incremental dream failed')
    assert.match(
        String(captured.warnings[0]?.[0]),
        /workflowError="automatic incremental dream failed"/u
    )
    assert.equal(captured.warnings[0]?.[1], stateError)
})

it('logs Dream job context and preserves the original background error', async () => {
    const jobStore = createJobStore()
    const backgroundError = new Error('manual Dream failed')
    const captured = createCapturedLogger()
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
        captured.logger
    )

    await coordinator.runManual(scope.presetId)
    await waitFor(
        () => captured.warnings.length >= 1,
        'Dream background warning'
    )

    assert.match(
        String(captured.warnings.at(-1)?.[0]),
        /event=dream.failed workflow=dream jobId=job-1 .*presetId=preset-1.*trigger=manual/u
    )
    assert.equal(captured.warnings.at(-1)?.[1], backgroundError)
})

it('logs a Dream failure when marking the job as running fails', async () => {
    const jobStore = createJobStore()
    const stateError = new Error('mark running failed')
    const captured = createCapturedLogger()
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 3
        },
        { run: async () => createDreamRunResult() },
        incrementalDream,
        createDreamCoordinatorRepository(jobStore),
        { clearByPreset: () => {} },
        {
            markRunning: async () => {
                throw stateError
            },
            markCompleted: async () => {},
            markFailed: async () => {}
        },
        captured.logger
    )

    await coordinator.runManual(scope.presetId)
    await waitFor(
        () => captured.warnings.length === 1,
        'Dream mark-running failure'
    )

    assert.match(
        String(captured.warnings[0]?.[0]),
        /event=dream.failed workflow=dream jobId=job-1/u
    )
    assert.equal(captured.warnings[0]?.[1], stateError)
})

it('logs and persists a Dream failure when completion persistence fails', async () => {
    const jobStore = createJobStore()
    const stateError = new Error('mark completed failed')
    const captured = createCapturedLogger()
    let persistedFailure: unknown
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 3
        },
        { run: async () => createDreamRunResult() },
        incrementalDream,
        createDreamCoordinatorRepository(jobStore),
        { clearByPreset: () => {} },
        {
            markRunning: async () => {},
            markCompleted: async () => {
                throw stateError
            },
            markFailed: async (_jobId, error) => {
                persistedFailure = error
            }
        },
        captured.logger
    )

    await coordinator.runManual(scope.presetId)
    await waitFor(
        () => captured.warnings.length === 1,
        'Dream mark-completed failure'
    )

    assert.equal(persistedFailure, stateError)
    assert.equal(captured.warnings[0]?.[1], stateError)
})

it('logs the original Dream error when failed-state persistence also fails', async () => {
    const jobStore = createJobStore()
    const workflowError = new Error('Dream workflow failed')
    const stateError = new Error('mark failed failed')
    const captured = createCapturedLogger()
    const coordinator = createDreamCoordinator(
        {
            enableAutoDream: false,
            autoDreamMemoryGrowthThreshold: 3
        },
        {
            run: async () => {
                throw workflowError
            }
        },
        incrementalDream,
        createDreamCoordinatorRepository(jobStore),
        { clearByPreset: () => {} },
        {
            markRunning: async () => {},
            markCompleted: async () => {},
            markFailed: async () => {
                throw stateError
            }
        },
        captured.logger
    )

    await coordinator.runManual(scope.presetId)
    await waitFor(
        () => captured.warnings.length === 1,
        'Dream mark-failed failure'
    )

    assert.match(
        String(captured.warnings[0]?.[0]),
        /jobStateUpdateError="Error: mark failed failed/u
    )
    assert.equal(captured.warnings[0]?.[1], workflowError)
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
            logger
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
        logger
    )

    await coordinator.runManual(scope.presetId)
    await waitFor(() => jobStore.jobs[0]?.status === 'failed', 'Dream failure')

    assert.deepEqual(clearedPresets, [scope.presetId])
})
