import assert from 'node:assert/strict'
import { vi } from 'vitest'
import type {
    LivingMemoryPresetExport,
    MemoryEntryRecord,
    MemoryJobRecord
} from '../src/contracts/memory'
import type {
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink
} from '../src/contracts/vector_index'
import {
    LivingMemoryMutationService,
    MEMORY_DELETE_BATCH_SIZE
} from '../src/service/app/memory_mutation_service'
import type { LivingMemoryLogger } from '../src/service/logging/logger'
import {
    createSyntheticSpeakerLabel,
    createSpeakerKey
} from '../src/service/memory/speaker_identity'
import {
    LivingMemoryFactsCommittedError,
    LivingMemoryVectorIndexError
} from '../src/service/vector_index/errors'
import { withLivingMemoryRepository } from './persistence-test-utils'
import type { LivingMemoryRepository } from '../src/service/persistence/repository'
import { createDreamSessionTools } from '../src/service/workflows/dream/session/tools'
import {
    createDreamSessionState,
    getDreamCoverage,
    advanceDreamBatch,
    pendingDreamMemoryIds,
    recordSkippedDreamBatch
} from '../src/service/workflows/dream/session/state'

const presetId = 'preset-indexed-mutations'
const scope = { presetId, conversationId: 'conversation-1' }

const createSession = (
    repository: LivingMemoryRepository,
    mutations: LivingMemoryMutationService,
    batches: MemoryEntryRecord[][]
) => {
    const state = createDreamSessionState(
        batches.flatMap((entries) => entries.map((entry) => entry.id))
    )
    state.clusters = batches.map((entries, index) => ({
        id: `batch-${index}`,
        entries
    }))
    const tools = createDreamSessionTools({
        presetId,
        state,
        mutations,
        speakers: repository
    })
    const invoke = (name: string, input: Record<string, unknown>) => {
        const tool = tools.find((tool) => tool.name === `living_memory_${name}`)
        assert.ok(tool)
        return tool.invoke(input, { configurable: { preset: presetId } })
    }
    return { state, tools, invoke }
}

const sessionMemory = {
    type: 'fact',
    content: '整理后的记忆',
    summary: '整理后的摘要',
    keywords: ['整理'],
    sentiment: 'neutral',
    importance: 0.5,
    speakerLabels: []
}

const createLoggerStub = () => {
    const warns: string[] = []
    const logger = {
        summary: (event: string) => {
            warns.push(event)
        }
    } as unknown as LivingMemoryLogger
    return { warns, logger }
}

const flushBackgroundTasks = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

class MemoryIndexSinkStub implements MemoryIndexMutationSink {
    readonly mutations: MemoryIndexMutationBatch[] = []
    readonly clearedPresets: string[] = []
    readonly reconciledPresets: string[] = []
    applyError: Error | null = null
    presetReady = true
    reconcileError: Error | null = null

    async waitForMaintenance() {}

    assertPresetReady(targetPresetId: string) {
        if (!this.presetReady) {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                'building',
                `vector index is not ready: preset=${targetPresetId}`
            )
        }
    }

    async applyMutation(batch: MemoryIndexMutationBatch) {
        if (this.applyError !== null) {
            throw this.applyError
        }
        this.mutations.push(batch)
    }

    async clearPreset(targetPresetId: string) {
        this.clearedPresets.push(targetPresetId)
    }

    async reconcilePreset(targetPresetId: string, reason: string) {
        if (this.reconcileError !== null) {
            throw this.reconcileError
        }
        this.reconciledPresets.push(`${targetPresetId}:${reason}`)
        const now = new Date()
        const job: MemoryJobRecord = {
            id: 'index-job',
            presetId: targetPresetId,
            conversationId: 'vector-index',
            kind: 'index',
            status: 'pending',
            input: `reconcile: ${reason}`,
            detail: null,
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        }
        return job
    }
}

it.each([false, true])(
    'splits Dream memories with provenance and consolidation (index failure: %s)',
    async (indexFailure) => {
        await withLivingMemoryRepository(async (ctx, repository) => {
            const sink = new MemoryIndexSinkStub()
            if (indexFailure)
                sink.applyError = new Error('injected index failure')
            const mutations = new LivingMemoryMutationService(
                repository,
                sink,
                createLoggerStub().logger
            )
            await repository.registerMissingPresetSpeakers(presetId, [
                { speakerKey: 'alice', speakerLabel: 'Alice' },
                { speakerKey: 'bob', speakerLabel: 'Bob' }
            ])
            const [source] = await repository.appendMemories(
                scope,
                [
                    {
                        role: 'user',
                        content: 'Alice喜欢茶，Bob喜欢咖啡。',
                        transcriptLines: ['Alice喜欢茶，Bob喜欢咖啡。']
                    }
                ],
                [
                    {
                        ...sessionMemory,
                        type: 'fact',
                        speakerKeys: ['alice', 'bob']
                    }
                ],
                '来源会话'
            )
            const { state, tools, invoke } = createSession(
                repository,
                mutations,
                [[source]]
            )
            assert.deepEqual(
                tools.map((tool) => tool.name).sort(),
                [
                    'living_memory_update_memory',
                    'living_memory_merge_memories',
                    'living_memory_split_memory',
                    'living_memory_delete_memory',
                    'living_memory_checked_memory'
                ].sort()
            )
            advanceDreamBatch(state)
            const result = JSON.parse(
                await invoke('split_memory', {
                    sourceMemoryId: source.id,
                    memories: [
                        {
                            ...sessionMemory,
                            content: 'Alice喜欢茶。',
                            keywords: ['茶'],
                            speakerLabels: ['Alice']
                        },
                        {
                            ...sessionMemory,
                            content: 'Bob喜欢咖啡。',
                            keywords: ['咖啡'],
                            speakerLabels: ['Bob']
                        }
                    ]
                })
            )
            assert.equal(result.memoryIds.length, 2)
            assert.equal(result.archivedMemoryId, source.id)
            assert.equal(result.warnings.length, indexFailure ? 1 : 0)
            const children = await repository.getEntriesByPresetAndIds(
                presetId,
                result.memoryIds
            )
            for (const child of children) {
                assert.equal(child.status, 'active')
                assert.equal(child.isConsolidated, true)
                assert.deepEqual(child.sourceOrigins, source.sourceOrigins)
                assert.equal(child.sourceConversationId, scope.conversationId)
                assert.equal(child.sourceLabel, source.sourceLabel)
                assert.equal(state.availableMemoryIds.has(child.id), true)
                assert.equal(state.targetMemoryIds.has(child.id), false)
            }
            assert.deepEqual(
                children.map((entry) => entry.speakerKeys[0]).sort(),
                ['alice', 'bob']
            )
            const links = await ctx.database.get(
                'living_memory_entry_speaker',
                { presetId }
            )
            assert.equal(links.length, 2)
            assert.ok(
                links.every((link) => result.memoryIds.includes(link.memoryId))
            )
            assert.equal(
                (await repository.getEntryById(source.id))?.status,
                'archived'
            )
            assert.equal(getDreamCoverage(state).processedCount, 1)
            assert.deepEqual(pendingDreamMemoryIds(state), [])
            assert.equal(state.stats.split, 1)
            assert.equal(state.stats.archived, 1)
            if (indexFailure) {
                assert.equal(sink.reconciledPresets.length, 1)
            } else {
                assert.deepEqual(
                    sink.mutations[0].upserts.map((item) => item.vectorAction),
                    ['replace', 'replace', 'preserve']
                )
            }
            await invoke('update_memory', {
                memoryId: result.memoryIds[0],
                memory: sessionMemory
            })
            assert.equal(getDreamCoverage(state).processedCount, 1)
        })
    }
)

it('rolls back split entries, source archival and speaker links together', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const source = await repository.createMemory(
            scope,
            { type: 'fact', content: '两个主题' },
            ['alice']
        )
        const beforeLinks = await ctx.database.get(
            'living_memory_entry_speaker',
            { presetId }
        )
        const transact = ctx.database.transact.bind(ctx.database)
        const spy = vi
            .spyOn(ctx.database, 'transact')
            .mockImplementationOnce((callback) =>
                transact(async (database) => {
                    await callback(database)
                    throw new Error('injected transaction failure')
                })
            )
        try {
            await assert.rejects(
                repository.splitMemory(
                    presetId,
                    source.id,
                    [
                        {
                            ...sessionMemory,
                            type: 'fact',
                            speakerKeys: ['alice']
                        },
                        { ...sessionMemory, type: 'fact', speakerKeys: [] }
                    ],
                    true
                ),
                /injected transaction failure/
            )
        } finally {
            spy.mockRestore()
        }
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [
            source
        ])
        assert.deepEqual(
            await ctx.database.get('living_memory_entry_speaker', { presetId }),
            beforeLinks
        )
    })
})

it('tracks Dream coverage across batches and reuses merged memories', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const entries: MemoryEntryRecord[] = []
        for (let index = 0; index < 6; index++) {
            entries.push(
                await repository.createMemory(scope, {
                    type: 'fact',
                    content: `memory-${index}`
                })
            )
        }
        const [a, b, c, d, e, outside] = entries
        const { state, tools, invoke } = createSession(repository, mutations, [
            [a, b, c],
            [d, e]
        ])
        assert.equal(tools.length, 5)
        assert.equal(
            tools.some((tool) => tool.name === 'living_memory_create_memory'),
            false
        )
        advanceDreamBatch(state)
        assert.equal(state.availableMemoryIds.has(outside.id), false)
        assert.equal(getDreamCoverage(state).processedCount, 0)
        const merged = JSON.parse(
            await invoke('merge_memories', {
                sourceMemoryIds: [a.id, b.id],
                memory: sessionMemory
            })
        )
        assert.equal(
            (await repository.getEntryById(merged.memoryId))?.isConsolidated,
            true
        )
        assert.deepEqual(pendingDreamMemoryIds(state), [c.id])
        recordSkippedDreamBatch(state, 'round-limit')
        assert.deepEqual(
            advanceDreamBatch(state)?.entries.map((entry) => entry.id),
            [d.id, e.id]
        )
        await invoke('checked_memory', {
            memoryIds: [c.id, d.id],
            reason: '复查后无需修改'
        })
        await invoke('update_memory', {
            memoryId: merged.memoryId,
            memory: sessionMemory
        })
        await invoke('delete_memory', { memoryId: e.id })
        assert.equal(advanceDreamBatch(state), undefined)
        assert.deepEqual(getDreamCoverage(state), {
            targetCount: 5,
            processedCount: 5,
            unprocessedMemoryIds: []
        })
        assert.deepEqual(state.skippedBatches[0].memoryIds, [c.id])
        assert.equal(state.stats.merged, 1)
        assert.equal(state.stats.archived, 3)
        assert.equal(
            (await repository.getEntryById(outside.id))?.isConsolidated,
            false
        )
        assert.ok(
            sink.mutations.every((batch) =>
                batch.upserts
                    .filter((item) => item.document.status === 'active')
                    .every((item) => item.document.isConsolidated)
            )
        )
    })
})

it('retains successful Dream coverage when only index synchronization fails', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const entries: MemoryEntryRecord[] = []
        for (let index = 0; index < 5; index++) {
            entries.push(
                await repository.createMemory(scope, {
                    type: 'fact',
                    content: `memory-${index}`
                })
            )
        }
        const [updated, a, b, checked, archived] = entries
        const { state, invoke } = createSession(repository, mutations, [
            entries
        ])
        advanceDreamBatch(state)
        const outputs = [
            JSON.parse(
                await invoke('update_memory', {
                    memoryId: updated.id,
                    memory: sessionMemory
                })
            ),
            JSON.parse(
                await invoke('merge_memories', {
                    sourceMemoryIds: [a.id, b.id],
                    memory: sessionMemory
                })
            ),
            JSON.parse(
                await invoke('checked_memory', {
                    memoryIds: [checked.id],
                    reason: '内容完整'
                })
            ),
            JSON.parse(await invoke('delete_memory', { memoryId: archived.id }))
        ]
        assert.ok(outputs.every((output) => output.warnings.length === 1))
        assert.equal(getDreamCoverage(state).processedCount, 5)
        const stored = await repository.listEntriesByPreset(presetId)
        assert.equal(stored.length, 6)
        assert.equal(
            stored.filter((entry) => entry.status === 'archived').length,
            3
        )
        assert.ok(
            stored
                .filter((entry) => entry.status === 'active')
                .every((entry) => entry.isConsolidated)
        )
        assert.equal(state.availableMemoryIds.has(outputs[1].memoryId), true)
        await flushBackgroundTasks()
        assert.equal(sink.reconciledPresets.length, 4)
    })
})

it('rejects unavailable or stale Dream targets before recording successful coverage', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const active = await repository.createMemory(scope, {
            type: 'fact',
            content: 'active'
        })
        const stale = await repository.createMemory(scope, {
            type: 'fact',
            content: 'stale'
        })
        const { state, invoke } = createSession(repository, mutations, [
            [active, stale]
        ])
        advanceDreamBatch(state)
        await repository.archiveActiveEntries(presetId, [stale.id])
        await assert.rejects(
            invoke('checked_memory', {
                memoryIds: [active.id, stale.id],
                reason: '内容完整'
            })
        )
        assert.equal(
            (await repository.getEntryById(active.id))?.isConsolidated,
            false
        )
        await assert.rejects(
            invoke('merge_memories', {
                sourceMemoryIds: [active.id, stale.id],
                memory: sessionMemory
            })
        )
        await assert.rejects(
            invoke('update_memory', {
                memoryId: stale.id,
                memory: sessionMemory
            })
        )
        await assert.rejects(invoke('delete_memory', { memoryId: stale.id }))
        await assert.rejects(
            invoke('split_memory', {
                sourceMemoryId: 'not-provided',
                memories: [sessionMemory, sessionMemory]
            })
        )
        await assert.rejects(
            invoke('checked_memory', {
                memoryIds: [active.id, 'not-provided'],
                reason: '内容完整'
            })
        )
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 2)
        assert.equal(getDreamCoverage(state).processedCount, 0)
        assert.equal(
            (await repository.getEntryById(active.id))?.status,
            'active'
        )
        assert.deepEqual(sink.mutations, [])
        await invoke('checked_memory', {
            memoryIds: [active.id, active.id],
            reason: '内容完整'
        })
        await invoke('update_memory', {
            memoryId: active.id,
            memory: sessionMemory
        })
        assert.equal(getDreamCoverage(state).processedCount, 1)
        assert.equal(state.stats.kept, 1)
        assert.equal(state.stats.updated, 1)
    })
})

it('writes create, update, and delete facts through to the vector index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const memory = await mutations.createMemory(scope, {
            type: 'fact',
            content: 'original content',
            summary: 'original summary'
        })

        await mutations.updateMemory(memory.id, {
            summary: 'updated summary'
        })
        await mutations.updateMemory(memory.id, {
            content: 'updated content'
        })
        await mutations.deleteMemory(memory.id)

        assert.equal(sink.mutations.length, 4)
        assert.equal(sink.mutations[0].upserts[0].vectorAction, 'replace')
        assert.equal(sink.mutations[1].upserts[0].vectorAction, 'preserve')
        assert.equal(sink.mutations[2].upserts[0].vectorAction, 'replace')
        assert.deepEqual(sink.mutations[3].deletes, [
            { id: memory.id, presetId }
        ])
        assert.equal(await repository.getEntryById(memory.id), undefined)
    })
})

it('reports committed facts when vector synchronization fails', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        let failure: unknown
        try {
            await mutations.createMemory(scope, {
                type: 'fact',
                content: 'committed content'
            })
        } catch (error) {
            failure = error
        }

        assert.ok(failure instanceof LivingMemoryFactsCommittedError)
        assert.equal(failure.factsCommitted, true)
        assert.match(failure.message, /injected index failure/u)
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 1)
    })
})

it('preserves vectors for consolidation and clears the preset index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const memory = await mutations.createMemory(scope, {
            type: 'fact',
            content: 'memory to consolidate'
        })

        await mutations.setMemoryConsolidation(presetId, [memory.id], true)
        await mutations.clearPresetData(presetId)

        assert.equal(sink.mutations[1].upserts[0].vectorAction, 'preserve')
        assert.deepEqual(sink.clearedPresets, [presetId])
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
    })
})

it('synchronizes a Dream merge as one vector index mutation', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const target = await repository.createMemory(scope, {
            type: 'fact',
            content: 'target'
        })
        const source = await repository.createMemory(scope, {
            type: 'fact',
            content: 'source'
        })

        const result = await mutations.mergeActiveMemories(
            presetId,
            [target.id, source.id],
            {
                speakerKeys: [],
                type: 'fact',
                content: 'merged content',
                keywords: ['merged'],
                summary: 'merged summary',
                sentiment: 'neutral',
                importance: 0.8
            },
            true
        )

        assert.equal(sink.mutations.length, 1)
        assert.deepEqual(
            sink.mutations[0].upserts.map((upsert) => ({
                id: upsert.document.id,
                action: upsert.vectorAction,
                status: upsert.document.status
            })),
            [
                { id: result.memory.id, action: 'replace', status: 'active' },
                { id: target.id, action: 'preserve', status: 'archived' },
                { id: source.id, action: 'preserve', status: 'archived' }
            ]
        )
    })
})

it('queues preset reconciliation after import without applying mutations', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const data: LivingMemoryPresetExport = {
            version: 2,
            exportedAt: '2026-08-08T00:00:00.000Z',
            sourcePresetId: 'source-preset',
            entries: [],
            userProfiles: [],
            presetSpeakers: []
        }

        const result = await mutations.importPreset(presetId, data)

        assert.deepEqual(sink.reconciledPresets, [`${presetId}:preset import`])
        assert.deepEqual(sink.mutations, [])
        assert.equal(result.indexJobId, 'index-job')
    })
})

it('rejects memory creation before committing facts when the index is not ready', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.presetReady = false
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        await assert.rejects(
            mutations.createMemory(scope, {
                type: 'fact',
                content: 'should not be committed'
            }),
            (error: unknown) => {
                assert.ok(error instanceof LivingMemoryVectorIndexError)
                assert.match(error.message, /not ready/u)
                return true
            }
        )

        assert.equal((await repository.listEntriesByPreset(presetId)).length, 0)
        assert.deepEqual(sink.mutations, [])
        assert.deepEqual(sink.reconciledPresets, [])
    })
})

it('schedules one background reconciliation after a failed index sync', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        await assert.rejects(
            mutations.createMemory(scope, {
                type: 'fact',
                content: 'committed content'
            }),
            LivingMemoryFactsCommittedError
        )
        await flushBackgroundTasks()

        assert.deepEqual(sink.reconciledPresets, [
            `${presetId}:mutation index sync failure`
        ])
    })
})

it('keeps the committed-facts failure when the scheduled reconciliation rejects', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        sink.applyError = new Error('injected index failure')
        sink.reconcileError = new Error('injected reconcile failure')
        const { warns, logger } = createLoggerStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            logger
        )

        await assert.rejects(
            mutations.createMemory(scope, {
                type: 'fact',
                content: 'committed content'
            }),
            LivingMemoryFactsCommittedError
        )
        await flushBackgroundTasks()

        assert.deepEqual(warns, ['索引对账调度失败'])
        assert.equal((await repository.listEntriesByPreset(presetId)).length, 1)
    })
})

it('deletes memories in one batch and synchronizes the vector index', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const created = []
        for (let index = 0; index < 3; index++) {
            created.push(
                await repository.createMemory(scope, {
                    type: 'fact',
                    content: `bulk-${index}`
                })
            )
        }

        const result = await mutations.deleteMemories(
            presetId,
            created.map((memory) => memory.id)
        )

        assert.deepEqual(result, { deleted: 3 })
        assert.equal(sink.mutations.length, 1)
        // getEntriesByPresetAndIds 的返回顺序不保证与传入一致，按 id 排序后比较。
        assert.deepEqual(
            [...sink.mutations[0].deletes]
                .map((entry) => entry.id)
                .sort((left, right) => left.localeCompare(right)),
            created
                .map((memory) => memory.id)
                .sort((left, right) => left.localeCompare(right))
        )
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
    })
})

it('skips duplicate, missing, and cross-preset ids in bulk deletion', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const own = await repository.createMemory(scope, {
            type: 'fact',
            content: 'own preset'
        })
        const foreign = await repository.createMemory(
            { presetId: 'preset-other', conversationId: 'conversation-1' },
            { type: 'fact', content: 'foreign preset' }
        )

        const result = await mutations.deleteMemories(presetId, [
            own.id,
            own.id,
            'missing-id',
            foreign.id
        ])

        assert.deepEqual(result, { deleted: 1 })
        assert.deepEqual(sink.mutations[0].deletes, [{ id: own.id, presetId }])
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
        assert.equal(
            (await repository.listEntriesByPreset('preset-other')).length,
            1
        )
    })
})

it('returns zero deletions without side effects for an empty id list', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )

        const result = await mutations.deleteMemories(presetId, [])

        assert.deepEqual(result, { deleted: 0 })
        assert.deepEqual(sink.mutations, [])
    })
})

it('splits bulk deletions into fixed-size batches', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const total = MEMORY_DELETE_BATCH_SIZE + 3
        const extracted = Array.from({ length: total }, (_, index) => ({
            type: 'fact' as const,
            content: `batched-${index}`,
            keywords: [],
            summary: '',
            sentiment: '',
            importance: 0.5,
            speakerKeys: []
        }))
        const created = await Promise.all(
            extracted.map((memory) =>
                repository.createMemory(scope, memory, memory.speakerKeys)
            )
        )

        const result = await mutations.deleteMemories(
            presetId,
            created.map((memory) => memory.id)
        )

        assert.deepEqual(result, { deleted: total })
        assert.equal(sink.mutations.length, 2)
        assert.equal(sink.mutations[0].deletes.length, MEMORY_DELETE_BATCH_SIZE)
        assert.equal(sink.mutations[1].deletes.length, 3)
        assert.deepEqual(await repository.listEntriesByPreset(presetId), [])
    })
})

it('registers caller-provided speaker keys before create and update commit', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        const memory = await mutations.createMemory(
            scope,
            { type: 'fact', content: 'manual memory' },
            ['caller-key']
        )
        assert.equal(
            (await repository.listPresetSpeakers(presetId)).find(
                (speaker) => speaker.speakerKey === 'caller-key'
            )?.speakerLabel,
            'user:caller-k'
        )

        await mutations.updateMemory(memory.id, {
            speakerKeys: ['patched-key']
        })
        assert.equal(
            (await repository.listPresetSpeakers(presetId)).find(
                (speaker) => speaker.speakerKey === 'patched-key'
            )?.speakerLabel,
            'user:patched-'
        )
    })
})

it('registers scope-derived default speaker keys on create', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        await mutations.createMemory(
            { ...scope, platform: 'onebot', speakerId: 'user-9' },
            { type: 'fact', content: 'scope attributed memory' }
        )
        const derivedKey = createSpeakerKey('onebot', 'user-9')
        assert.equal(
            (await repository.listPresetSpeakers(presetId)).find(
                (speaker) => speaker.speakerKey === derivedKey
            )?.speakerLabel,
            createSyntheticSpeakerLabel(derivedKey)
        )
    })
})

it('backfills registry rows for active memory keys missing rows on Dream coverage', async () => {
    // issue #6 回归：历史记忆键缺注册行时 Dream 渲染会崩，coverage 在
    // 预设级队列内重读活跃键并以合成标签补齐缺失行。
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sink = new MemoryIndexSinkStub()
        const mutations = new LivingMemoryMutationService(
            repository,
            sink,
            createLoggerStub().logger
        )
        await repository.createMemory(
            scope,
            {
                type: 'fact',
                content: 'legacy memory without registry row',
                keywords: [],
                summary: '',
                sentiment: '',
                importance: 0.5
            },
            ['orphan-key']
        )

        const speakers = await mutations.ensurePresetSpeakersCoverage(presetId)

        assert.equal(
            speakers.find((speaker) => speaker.speakerKey === 'orphan-key')
                ?.speakerLabel,
            createSyntheticSpeakerLabel('orphan-key')
        )
        assert.equal(
            (await mutations.ensurePresetSpeakersCoverage(presetId)).filter(
                (speaker) => speaker.speakerKey === 'orphan-key'
            ).length,
            1
        )
    })
})
