import assert from 'node:assert/strict'
import type { DreamVectorProvider } from '../src/contracts/vector_index'
import { DreamClusterer } from '../src/service/workflows/dream/clustering'
import {
    buildDreamPartitionTargetSizes,
    partitionDreamEntries,
    selectDreamPartitionCount
} from '../src/service/workflows/dream/partitioning'
import type { DreamWorkerRunner } from '../src/service/workflows/dream/worker/protocol'
import {
    createInitialPartition,
    selectBestInitialPartition
} from '../src/service/workflows/dream/partitioning/initial'
import { optimizePartition } from '../src/service/workflows/dream/partitioning/optimization'
import {
    buildSimilarityData,
    calculatePartitionQuality,
    compareEntryIds
} from '../src/service/workflows/dream/partitioning/similarity'
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

it('selects balanced Dream partition counts around the target size', () => {
    assert.equal(selectDreamPartitionCount(400), 2)
    assert.equal(selectDreamPartitionCount(700), 2)
    assert.equal(selectDreamPartitionCount(720), 3)
    assert.equal(selectDreamPartitionCount(1_000), 3)
    assert.equal(selectDreamPartitionCount(2_000), 7)
    assert.equal(selectDreamPartitionCount(5_000), 17)
})

it('partitions every Dream entry exactly once with deterministic balanced output', () => {
    const entries = createEntries(720)
    const first = partitionDreamEntries(entries)
    const second = partitionDreamEntries([...entries].reverse())
    const firstIds = first.map((batch) => batch.map((entry) => entry.id))
    const secondIds = second.map((batch) => batch.map((entry) => entry.id))

    assert.deepEqual(
        first.map((batch) => batch.length),
        [240, 240, 240]
    )
    assert.deepEqual(secondIds, firstIds)
    assert.equal(new Set(firstIds.flat()).size, entries.length)
    assert.deepEqual(
        [...firstIds.flat()].sort(),
        entries.map((entry) => entry.id)
    )
})

it('partitions 5000 entries within the hard size limit without duplicates', () => {
    const entries = createEntries(5_000)
    const partitions = partitionDreamEntries(entries)
    const ids = partitions.flatMap((partition) =>
        partition.map((entry) => entry.id)
    )
    const sizes = partitions.map((partition) => partition.length)

    assert.equal(partitions.length, 17)
    assert.ok(sizes.every((size) => size <= 350))
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1)
    assert.equal(ids.length, entries.length)
    assert.equal(new Set(ids).size, entries.length)
})

it('handles one partition, the 350 boundary, and entries without keywords', () => {
    const boundaryEntries = createEntries(350)
    assert.deepEqual(
        partitionDreamEntries(boundaryEntries).map((batch) => batch.length),
        [350]
    )

    const entriesWithoutKeywords = createEntries(700).map((entry) => ({
        ...entry,
        keywords: []
    }))
    const first = partitionDreamEntries(entriesWithoutKeywords)
    const second = partitionDreamEntries([...entriesWithoutKeywords].reverse())
    assert.deepEqual(
        first.map((batch) => batch.length),
        [350, 350]
    )
    assert.deepEqual(
        second.map((batch) => batch.map((entry) => entry.id)),
        first.map((batch) => batch.map((entry) => entry.id))
    )
})

it('partitions to exact ceil(n / targetSize) batches within the target size', () => {
    const entries = createEntries(100)
    const batches = partitionDreamEntries(entries, { targetSize: 30 })
    const ids = batches.flatMap((batch) => batch.map((entry) => entry.id))

    assert.deepEqual(
        batches.map((batch) => batch.length),
        [25, 25, 25, 25]
    )
    assert.ok(batches.every((batch) => batch.length <= 30))
    assert.equal(ids.length, entries.length)
    assert.equal(new Set(ids).size, entries.length)
})

it('hits the target size boundary exactly', () => {
    // 分区器保证各批规模的差不超过 1，但较大批的顺序不固定，排序后比较。
    const sizesOf = (count: number) =>
        partitionDreamEntries(createEntries(count), {
            targetSize: 30
        })
            .map((batch) => batch.length)
            .sort((left, right) => right - left)

    assert.deepEqual(sizesOf(31), [16, 15])
    assert.deepEqual(sizesOf(59), [30, 29])
    assert.deepEqual(sizesOf(60), [30, 30])
    assert.deepEqual(sizesOf(61), [21, 20, 20])
})

it('selects the highest-quality initial partition across all starts', () => {
    const entries = createEntries(720).sort((left, right) =>
        compareEntryIds(left.id, right.id)
    )
    const batchCount = selectDreamPartitionCount(entries.length)
    const targetSizes = buildDreamPartitionTargetSizes(
        entries.length,
        batchCount
    )
    const { degrees, similarities } = buildSimilarityData(entries)
    const qualities = Array.from({ length: 3 }, (_, attempt) => {
        const state = createInitialPartition(
            entries,
            similarities,
            degrees,
            targetSizes,
            attempt
        )
        return calculatePartitionQuality(
            state.batches,
            similarities,
            entries.length
        )
    })
    const selected = selectBestInitialPartition(
        entries,
        similarities,
        degrees,
        targetSizes,
        qualities.length
    )

    assert.equal(selected.quality, Math.max(...qualities))
})

it('never lowers partition quality during local optimization', () => {
    const entries = createEntries(720).sort((left, right) =>
        compareEntryIds(left.id, right.id)
    )
    const batchCount = selectDreamPartitionCount(entries.length)
    const targetSizes = buildDreamPartitionTargetSizes(
        entries.length,
        batchCount
    )
    const { degrees, similarities } = buildSimilarityData(entries)
    const state = createInitialPartition(
        entries,
        similarities,
        degrees,
        targetSizes,
        0
    )
    const before = calculatePartitionQuality(
        state.batches,
        similarities,
        entries.length
    )

    optimizePartition(entries, similarities, degrees, targetSizes, state)

    const after = calculatePartitionQuality(
        state.batches,
        similarities,
        entries.length
    )
    assert.ok(after > before)
})

it('keeps disconnected keyword islands in separate balanced partitions', () => {
    const entries = createEntries(400).map((entry, index) => ({
        ...entry,
        keywords: [index < 200 ? 'left-island' : 'right-island']
    }))
    const partitions = partitionDreamEntries(entries)

    assert.deepEqual(
        partitions.map((partition) => partition.length),
        [200, 200]
    )
    assert.ok(
        partitions.every(
            (partition) =>
                new Set(partition.flatMap((entry) => entry.keywords)).size === 1
        )
    )
})

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
        queryDreamNeighbors: async () => {
            throw new Error('initial batching only reads vectors')
        },
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
        vectors.reader.queryDreamNeighbors = async (queries) => ({
            generation: 'generation-1',
            backend: available ? 'hnsw' : 'unavailable',
            completed: available ? queries.length : 0,
            reason: available ? undefined : 'index-absent',
            rows: available
                ? queries.map((query) => ({
                      sourceIndex: query.sourceIndex,
                      hits: entries
                          .filter((entry) => entry.id !== query.sourceMemoryId)
                          .slice(0, 10)
                          .map((entry) => ({
                              memoryId: entry.id,
                              contentHash: createMemoryContentHash(
                                  entry.content
                              ),
                              cosineScore: 1
                          }))
                  }))
                : []
        })
        const refine = vi.fn(worker.refine)
        const clusters = await new DreamClusterer(vectors.reader, {
            ...worker,
            refine
        }).buildClusters(
            'preset-1',
            entries,
            undefined,
            undefined,
            performance.now() + 180_000,
            true
        )
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
