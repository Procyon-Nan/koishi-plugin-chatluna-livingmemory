import assert from 'node:assert/strict'
import type { DreamVectorProvider } from '../src/contracts/vector_index'
import { DreamClusterer } from '../src/service/workflows/dream/clustering'
import type { DreamWorkerRunner } from '../src/service/workflows/dream/worker/protocol'
import { bisectDreamMemories } from '../src/service/workflows/dream/semantic/bisect'
import { refineDreamMemories } from '../src/service/workflows/dream/semantic/refine'
import { validateDreamPlan } from '../src/service/workflows/dream/semantic/validate'
import { createMemoryContentHash } from '../src/service/vector_index/hashes'
import { createMemoryEntry } from './workflow-test-utils'

const createEntries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
        ...createMemoryEntry(`memory-${index.toString().padStart(4, '0')}`),
        keywords: [`group-${index % 8}`, `topic-${index % 23}`]
    }))

const createVectorReader = (entries: ReturnType<typeof createEntries>) => {
    const calls: string[][] = []
    const byId = new Map(
        entries.map((entry, index) => [
            entry.id,
            {
                memoryId: entry.id,
                contentHash: createMemoryContentHash(entry.content),
                status: 'active' as const,
                vector: new Float32Array([index + 1, 1])
            }
        ])
    )
    const reader: DreamVectorProvider = {
        queryDreamNeighbors: async () => ({
            generation: 'generation-1',
            backend: 'unavailable',
            completed: 0,
            reason: 'index-absent',
            rows: []
        }),
        readDreamVectors: async (_presetId, ids) => {
            calls.push(ids)
            return {
                embeddingModelId: 'test',
                dimension: 2,
                generation: 'generation-1',
                items: ids.map((id) => byId.get(id)!),
                missingMemoryIds: []
            }
        }
    }
    return { calls, reader, byId }
}

const worker: DreamWorkerRunner = {
    refine: async (input) => refineDreamMemories(input),
    bisect: async (input) => bisectDreamMemories(input)
}

it.each([0, 1, 29, 30, 31, 59, 60, 61, 135, 701])(
    'covers %i entries once within the minimum batch count',
    async (count) => {
        const entries = createEntries(count)
        const vectors = createVectorReader(entries)
        const clusterer = new DreamClusterer(vectors.reader, worker)
        const clusters = await clusterer.buildClusters('preset-1', entries)
        const ids = clusters.flatMap((cluster) =>
            cluster.entries.map((entry) => entry.id)
        )
        assert.equal(clusters.length, Math.ceil(count / 30))
        assert.ok(
            clusters.every(
                (cluster) =>
                    cluster.entries.length > 0 && cluster.entries.length <= 30
            )
        )
        assert.deepEqual(
            [...ids].sort(),
            entries.map((entry) => entry.id)
        )
        const reordered = await clusterer.buildClusters(
            'preset-1',
            [...entries].reverse()
        )
        assert.deepEqual(reordered, clusters)
    }
)

it('reads vectors in pages of 256 and keeps the source records', async () => {
    const entries = createEntries(701)
    const vectors = createVectorReader(entries)
    const clusters = await new DreamClusterer(
        vectors.reader,
        worker
    ).buildClusters('preset-1', entries)
    assert.deepEqual(
        vectors.calls.map((ids) => ids.length),
        [256, 256, 189]
    )
    const originals = new Map(entries.map((entry) => [entry.id, entry]))
    for (const entry of clusters.flatMap((cluster) => cluster.entries)) {
        assert.equal(entry, originals.get(entry.id))
    }
})

it('connects complete candidates to refinement and retains initial on ANN unavailability', async () => {
    for (const available of [false, true]) {
        const entries = createEntries(61)
        const vectors = createVectorReader(entries)
        vectors.reader.queryDreamNeighbors = async (queries) => {
            if (!available) {
                return {
                    generation: 'generation-1',
                    backend: 'unavailable',
                    completed: 0,
                    reason: 'index-absent',
                    rows: []
                }
            }
            const rows = queries.map((query) => {
                const hits = entries
                    .filter((entry) => entry.id !== query.sourceMemoryId)
                    .slice(0, 10)
                    .map((entry) => ({
                        memoryId: entry.id,
                        contentHash: createMemoryContentHash(entry.content),
                        cosineScore: 1
                    }))
                return { sourceIndex: query.sourceIndex, hits }
            })
            return {
                generation: 'generation-1',
                backend: 'hnsw',
                completed: queries.length,
                reason: undefined,
                rows
            }
        }
        const refine = vi.fn(worker.refine)
        const clusters = await new DreamClusterer(vectors.reader, {
            ...worker,
            refine
        }).buildClusters('preset-1', entries)
        assert.equal(refine.mock.calls.length, available ? 1 : 0)
        assert.equal(clusters.length, 3)
        assert.ok(
            clusters.every(
                (cluster) =>
                    cluster.entries.length > 0 && cluster.entries.length <= 30
            )
        )
        assert.deepEqual(
            clusters
                .flatMap((cluster) => cluster.entries.map((entry) => entry.id))
                .sort(),
            entries.map((entry) => entry.id)
        )
    }
})

it('rejects a changed index generation between vector pages', async () => {
    const entries = createEntries(257)
    const vectors = createVectorReader(entries)
    const read = vectors.reader.readDreamVectors
    vectors.reader.readDreamVectors = async (...args) => ({
        ...(await read(...args)),
        generation: String(vectors.calls.length)
    })
    await assert.rejects(
        new DreamClusterer(vectors.reader, worker).buildClusters(
            'preset-1',
            entries
        ),
        /索引代际已变化/
    )
})

it('rejects changed content before starting the algorithm', async () => {
    const entries = createEntries(31)
    const vectors = createVectorReader(entries)
    vectors.byId.get(entries[0].id)!.contentHash = 'changed'
    const bisect = vi.fn(worker.bisect)
    await assert.rejects(
        new DreamClusterer(vectors.reader, { ...worker, bisect }).buildClusters(
            'preset-1',
            entries
        ),
        /正文与向量快照不符/
    )
    assert.equal(bisect.mock.calls.length, 0)
})

it('stops submitting vector pages after cancellation', async () => {
    const entries = createEntries(257)
    const vectors = createVectorReader(entries)
    const controller = new AbortController()
    const read = vectors.reader.readDreamVectors
    vectors.reader.readDreamVectors = async (...args) => {
        const page = await read(...args)
        controller.abort(new Error('cancel vector read'))
        return page
    }
    await assert.rejects(
        new DreamClusterer(vectors.reader, worker).buildClusters(
            'preset-1',
            entries,
            undefined,
            controller.signal
        ),
        /cancel vector read/
    )
    assert.equal(vectors.calls.length, 1)
})

it('keeps separated directions together when both groups fit', async () => {
    const entries = createEntries(60)
    const vectors = createVectorReader(entries)
    for (let i = 0; i < entries.length; i++) {
        vectors.byId.get(entries[i].id)!.vector = new Float32Array(
            i < 30 ? [1, 0] : [0, 1]
        )
    }
    const clusters = await new DreamClusterer(
        vectors.reader,
        worker
    ).buildClusters('preset-1', entries)
    const groups = clusters.map((cluster) =>
        cluster.entries.map((entry) => entry.id).sort()
    )
    assert.ok(
        groups.some(
            (group) =>
                JSON.stringify(group) ===
                JSON.stringify(entries.slice(0, 30).map((entry) => entry.id))
        )
    )
    assert.ok(
        groups.some(
            (group) =>
                JSON.stringify(group) ===
                JSON.stringify(entries.slice(30).map((entry) => entry.id))
        )
    )
})

it('handles identical directions and checks cancellation and an unfinished deadline', () => {
    const input = {
        matrix: {
            entryCount: 61,
            dimension: 2,
            vectors: Float32Array.from({ length: 122 }, (_, i) =>
                i % 2 === 0 ? 1 : 0
            )
        },
        cancellation: new SharedArrayBuffer(4),
        budgetMs: 30_000
    }
    const result = bisectDreamMemories(input)
    validateDreamPlan(result.plan, 61)
    assert.deepEqual(result.plan, bisectDreamMemories(input).plan)
    assert.throws(
        () => bisectDreamMemories({ ...input, budgetMs: 0 }),
        /计算期限/
    )
    Atomics.store(new Int32Array(input.cancellation), 0, 1)
    assert.throws(() => bisectDreamMemories(input), /已取消/)
})
