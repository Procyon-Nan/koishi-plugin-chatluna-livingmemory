import assert from 'node:assert/strict'
import type {
    LivingMemoryPresetExport,
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
    LivingMemoryFactsCommittedError,
    LivingMemoryVectorIndexError
} from '../src/service/vector_index/errors'
import { withLivingMemoryRepository } from './persistence-test-utils'

const presetId = 'preset-indexed-mutations'
const scope = { presetId, conversationId: 'conversation-1' }

const createLoggerStub = () => {
    const warns: string[] = []
    const logger = {
        warn: (event: string) => {
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
            recallStrategy: null,
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

        await mutations.applyDreamMerge({
            presetId,
            target,
            sources: [source],
            patch: {
                type: 'fact',
                status: 'active',
                content: 'merged content',
                keywords: ['merged'],
                summary: 'merged summary',
                sentiment: 'neutral',
                importance: 0.8
            },
            sourceDisposition: 'archive',
            targetIsConsolidated: true,
            sourceIsConsolidated: true
        })

        assert.equal(sink.mutations.length, 1)
        assert.deepEqual(
            sink.mutations[0].upserts.map((upsert) => ({
                id: upsert.document.id,
                action: upsert.vectorAction,
                status: upsert.document.status
            })),
            [
                { id: target.id, action: 'replace', status: 'active' },
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

        assert.deepEqual(warns, ['memory.index.reconcile.failed'])
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
        const created = await repository.appendMemories(scope, [], extracted)

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
