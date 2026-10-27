import 'koishi-plugin-chatluna'
import assert from 'node:assert/strict'
import { AIMessage } from '@langchain/core/messages'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { ModelType } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type {
    ModelRequester,
    ModelRequestParams
} from 'koishi-plugin-chatluna/llm-core/platform/api'
import type { Context } from 'koishi'
import type { DreamRunResult } from '../src/service/workflows/dream/types'
import { LivingMemoryDreamService } from '../src/service/workflows/dream/service'
import { LivingMemoryDreamCoordinator } from '../src/service/workflows/dream/coordinator'
import { LivingMemoryDreamJobRunner } from '../src/service/workflows/dream/job_runner'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker'
import { LivingMemoryUserProfileService } from '../src/service/user_profile'
import { LivingMemoryMutationService } from '../src/service/app/memory_mutation_service'
import { bisectDreamMemories } from '../src/service/workflows/dream/semantic/bisect'
import { createMemoryContentHash } from '../src/service/vector_index/hashes'
import { getJobStatusLabel, getJobStatusTagType } from '../client/utils/display'
import { withLivingMemoryRepository } from './persistence-test-utils'
import {
    createDreamRunResult,
    createJobStore,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'

const runService = async (
    respond: (params: ModelRequestParams, round: number) => AIMessage,
    options: {
        mainModel?: string
        signal?: AbortSignal
        incremental?: boolean
        profileUsers?: string[]
    } = {}
) => {
    let outcome!: {
        result: DreamRunResult
        rounds: number
        profileCalls: string[][]
    }
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const entries = await Promise.all(
            Array.from({ length: 31 }, (_, i) =>
                repository.createMemory(
                    scope,
                    {
                        type: 'fact' as const,
                        content: `正文 ${i}`,
                        summary: `摘要 ${i}`,
                        keywords: ['共同主题'],
                        sentiment: '平静',
                        importance: 0.5
                    },
                    []
                )
            )
        )
        const profileCalls: string[][] = []
        if (options.profileUsers) {
            await repository.updateMemory(entries[0].id, {
                speakerKeys: options.profileUsers
            })
        }
        let rounds = 0
        const model = new ChatLunaChatModel({
            model: 'test',
            modelInfo: {
                name: 'test',
                type: ModelType.llm,
                capabilities: [],
                maxTokens: 1_000_000
            },
            modelMaxContextSize: 1_000_000,
            maxTokens: 8192,
            maxRetries: 0,
            requester: {
                async completion(params: ModelRequestParams) {
                    const message = respond(params, ++rounds)
                    return { message, text: '' }
                }
            } as ModelRequester
        })
        const mutations = new LivingMemoryMutationService(
            repository,
            {
                assertPresetReady: () => {},
                waitForMaintenance: async () => {},
                applyMutation: async () => {},
                clearPreset: async () => {},
                reconcilePreset: async () => {
                    throw new Error('unexpected reconcile')
                }
            },
            logger
        )
        const persona = { resolveOrGenerateCardText: async () => '测试人设' }
        const profiles = new LivingMemoryUserProfileService(
            {
                enableUserProfileInjection: options.profileUsers !== undefined,
                userProfileMinMemoryCount: 1,
                userProfileMemoryLimit: 10
            },
            repository,
            logger,
            persona
        )
        if (options.profileUsers) {
            profiles.regenerate = async (_preset, keys) => {
                profileCalls.push(keys)
                return { generated: keys.length, detail: '人物画像检查完成' }
            }
        }
        const service = new LivingMemoryDreamService(
            {
                chatluna: { createChatModel: async () => ({ value: model }) }
            } as unknown as Context,
            {
                mainModel: options.mainModel ?? 'test'
            },
            repository,
            mutations,
            {
                queryDreamNeighbors: async () => ({
                    generation: 'test',
                    available: false,
                    completed: 0,
                    reason: 'index-absent',
                    rows: []
                }),
                readVectorSnapshot: async (_presetId, ids) => ({
                    embeddingModelId: 'test',
                    dimension: 2,
                    generation: 'test',
                    missingMemoryIds: [],
                    items: ids.map((id) => ({
                        memoryId: id,
                        status: 'active',
                        contentHash: createMemoryContentHash(
                            entries.find((entry) => entry.id === id)!.content
                        ),
                        vector: new Float32Array([1, 0])
                    }))
                })
            },
            {
                refine: async () => {
                    throw new Error('initial batching uses bisect')
                },
                bisect: async (input) => bisectDreamMemories(input)
            },
            profiles,
            persona,
            { searchMemoriesDetailed: async () => [] }
        )
        const result = await service.run(
            scope.presetId,
            'job-test',
            logger,
            options.signal,
            options.incremental
                ? { mode: 'incremental', memoryIds: [entries[0].id] }
                : { mode: 'full' }
        )
        outcome = { result, rounds, profileCalls }
    })
    return outcome
}

const currentIds = (params: ModelRequestParams) => {
    const batch = [...params.input]
        .reverse()
        .find(
            (message) =>
                typeof message.content === 'string' &&
                message.content.startsWith('<dream_input>')
        )!
    return [...String(batch.content).matchAll(/^id=(.+)$/gm)].map(
        (match) => match[1]
    )
}
const checked = (ids: string[]) =>
    new AIMessage({
        content: '',
        tool_calls: [
            {
                name: 'living_memory_checked_memory',
                id: 'check',
                args: { memoryIds: ids, reason: '内容准确且无需改动' }
            }
        ]
    })

it('runs the production Dream service through real tools across batches and records coverage', async () => {
    const batchSizes: number[] = []
    const { result } = await runService((params) => {
        const ids = currentIds(params)
        batchSizes.push(ids.length)
        assert.equal(params.id, 'job-test')
        return checked(ids)
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.entryCount, 31)
    assert.equal(result.processedCount, 31)
    assert.equal(batchSizes.length, 2)
    assert.ok(batchSizes.every((size) => size <= 30))
    assert.doesNotMatch(result.detail, /人物画像/)
})

it('keeps successful operations and proceeds past an ineffective batch as partial', async () => {
    let firstId = ''
    const { result } = await runService((params, round) => {
        if (round === 1) {
            firstId = currentIds(params)[0]
            return checked([firstId])
        }
        return new AIMessage('没有工具操作')
    })
    assert.equal(result.status, 'partial')
    assert.equal(result.processedCount, 1)
    assert.equal(result.unprocessedMemoryIds.length, 30)
    assert.equal(result.skippedBatches.length, 2)
    assert.match(result.detail, /连续 3 轮/)
    assert.doesNotMatch(result.detail, /人物画像/)
})

it('retains completed operations and missing IDs when the session fatally fails', async () => {
    const controller = new AbortController()
    const { result } = await runService(
        (params, round) => {
            if (round === 1) return checked([currentIds(params)[0]])
            controller.abort(new Error('session aborted'))
            return new AIMessage('')
        },
        { signal: controller.signal }
    )
    assert.equal(result.status, 'failed')
    assert.equal(result.processedCount, 1)
    assert.equal(result.unprocessedMemoryIds.length, 30)
    assert.match(result.detail, /session aborted/)
})

it('reports missing model configuration as failed with the entire target set', async () => {
    const { result, rounds } = await runService(() => checked([]), {
        mainModel: ''
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.unprocessedMemoryIds.length, 31)
    assert.equal(rounds, 0)
})

it.each(['completed', 'partial', 'failed'] as const)(
    'persists %s outcome and successful-operation details',
    async (status) => {
        const store = createJobStore()
        const job = await store.createJob(scope, 'dream', '')
        const runner = new LivingMemoryDreamJobRunner(
            {
                run: async () => ({
                    ...createDreamRunResult(),
                    status,
                    processedCount: 1,
                    detail: 'checked 1; unprocessed: memory-2'
                })
            },
            new LivingMemoryJobTracker(store),
            logger
        )
        await runner.run(scope, job.id)
        assert.equal(job.status, status)
        assert.match(job.detail!, /checked 1/)
        assert.ok(job.finishedAt)
        if (status === 'partial') {
            assert.equal(getJobStatusLabel(job.status), '部分完成')
            assert.equal(getJobStatusTagType(job.status), 'warning')
        }
    }
)

it('serializes starts, recovers stale jobs and aborts and drains running jobs on stop', async () => {
    const store = createJobStore()
    let calls = 0
    let recoveries = 0
    const runner = new LivingMemoryDreamJobRunner(
        {
            run: async (_preset, _id, _logger, signal) => {
                calls++
                await new Promise<void>((resolve) =>
                    signal!.addEventListener('abort', () => resolve(), {
                        once: true
                    })
                )
                signal!.throwIfAborted()
                return createDreamRunResult()
            }
        },
        new LivingMemoryJobTracker(store),
        logger
    )
    const coordinator = new LivingMemoryDreamCoordinator(
        runner,
        {
            ...store,
            countActiveEntries: async () => 30,
            markStaleRunningJobsAsFailed: async () => {
                recoveries++
                return []
            }
        },
        logger
    )
    const [first, second] = await Promise.all([
        coordinator.start(scope.presetId),
        coordinator.start(scope.presetId)
    ])
    assert.equal(first.started, true)
    assert.equal(second.reason, 'preset-locked')
    await waitFor(() => calls === 1, 'running dream')
    assert.equal(recoveries, 1)
    await coordinator.stop()
    assert.equal(store.jobs[0].status, 'failed')
    assert.throws(() => coordinator.start(scope.presetId), /正在停止/)
})

it('does not start below 30 active memories and releases the starting lock after skipping', async () => {
    const store = createJobStore()
    let count = 29
    const coordinator = new LivingMemoryDreamCoordinator(
        { run: async () => {} },
        {
            ...store,
            countActiveEntries: async () => count
        },
        logger
    )
    assert.equal(
        (await coordinator.start(scope.presetId)).reason,
        'insufficient-memories'
    )
    assert.equal(store.jobs.length, 0)
    count = 30
    assert.equal((await coordinator.start(scope.presetId)).started, true)
    await coordinator.stop()
})

it('skips the model session for a singleton incremental group', async () => {
    const outcome = await runService(
        () => {
            throw new Error('singleton should not request a decision')
        },
        { incremental: true }
    )
    assert.equal(outcome.rounds, 0)
    assert.equal(outcome.result.status, 'completed')
    assert.equal(outcome.result.batchCount, 0)
    assert.equal(outcome.result.untouchedSeedIds.length, 1)
})

it('updates singleton seed profiles while skipping the Dream decision session', async () => {
    const outcome = await runService(
        () => {
            throw new Error('singleton should not request a decision')
        },
        { incremental: true, profileUsers: ['seed-user'] }
    )
    assert.equal(outcome.rounds, 0)
    assert.equal(outcome.result.status, 'completed')
    assert.deepEqual(outcome.profileCalls, [['seed-user']])
})
