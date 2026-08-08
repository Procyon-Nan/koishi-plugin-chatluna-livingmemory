import assert from 'node:assert/strict'
import type {
    LivingMemoryPresetExport,
    MemoryJobRecord
} from '../src/contracts/memory'
import type {
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink
} from '../src/contracts/vector_index'
import { LivingMemoryMutationService } from '../src/service/app/memory_mutation_service'
import { LivingMemoryFactsCommittedError } from '../src/service/vector_index/errors'
import { withLivingMemoryRepository } from './persistence-test-utils'

const presetId = 'preset-indexed-mutations'
const scope = { presetId, conversationId: 'conversation-1' }

class MemoryIndexSinkStub implements MemoryIndexMutationSink {
    readonly mutations: MemoryIndexMutationBatch[] = []
    readonly clearedPresets: string[] = []
    readonly reconciledPresets: string[] = []
    applyError: Error | null = null

    async waitForMaintenance() {}

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
        const mutations = new LivingMemoryMutationService(repository, sink)
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
        const mutations = new LivingMemoryMutationService(repository, sink)

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
        const mutations = new LivingMemoryMutationService(repository, sink)
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
        const mutations = new LivingMemoryMutationService(repository, sink)
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
        const mutations = new LivingMemoryMutationService(repository, sink)
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
