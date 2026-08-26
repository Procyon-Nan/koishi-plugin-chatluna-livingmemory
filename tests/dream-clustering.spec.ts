import assert from 'node:assert/strict'
import type { ManualDreamVectorReader } from '../src/contracts/vector_index'
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
import { createCapturedLogger, createMemoryEntry } from './workflow-test-utils'

const createEntries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
        ...createMemoryEntry(`memory-${index.toString().padStart(4, '0')}`),
        keywords: [`group-${index % 8}`, `topic-${index % 23}`]
    }))

const createDreamWorker = (
    runHdbscan: DreamWorkerRunner['runHdbscan']
): DreamWorkerRunner => ({
    partition: async (entries, targetSize) =>
        partitionDreamEntries(entries, { targetSize }),
    runHdbscan
})

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

it('keeps target-size partitions deterministic under shuffled input', () => {
    const entries = createEntries(100)
    const first = partitionDreamEntries(entries, { targetSize: 30 })
    const second = partitionDreamEntries([...entries].reverse(), {
        targetSize: 30
    })

    assert.deepEqual(
        second.map((batch) => batch.map((entry) => entry.id)),
        first.map((batch) => batch.map((entry) => entry.id))
    )
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
    const vectorById = new Map(
        entries.map((entry, index) => [
            entry.id,
            new Float32Array([index + 1, 1])
        ])
    )
    const reader: ManualDreamVectorReader = {
        readVectors: async (_presetId, memoryIds) => {
            calls.push(memoryIds)
            return new Map(memoryIds.map((id) => [id, vectorById.get(id)!]))
        }
    }
    return { calls, reader }
}

it('runs one global HDBSCAN pass over all first-pass noise', async () => {
    const entries = createEntries(351)
    const partitions = partitionDreamEntries(entries)
    const vectors = createVectorReader(entries)
    const callSizes: number[] = []
    const worker = createDreamWorker(async (input, onProgress) => {
        assert.equal(input.dimension, 2)
        assert.equal(input.vectors.length, input.entryCount * 2)
        assert.equal(onProgress, undefined)
        callSizes.push(input.entryCount)
        if (callSizes.length <= partitions.length) {
            return Int32Array.from({ length: input.entryCount }, (_, index) =>
                index === 0 ? 0 : -1
            )
        }
        return Int32Array.from({ length: input.entryCount }, (_, index) =>
            index < 3 ? 4 : -1
        )
    })
    const captured = createCapturedLogger()
    const clusterer = new DreamClusterer(vectors.reader, worker)

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries,
        captured.logger
    )

    assert.deepEqual(
        [...callSizes.slice(0, 2)].sort((left, right) => left - right),
        [175, 176]
    )
    assert.equal(callSizes[2], 349)
    assert.deepEqual(
        vectors.calls.map((ids) => ids.length),
        [175, 176, 349]
    )
    const reasons = clusters.map((cluster) => cluster.reason)
    assert.deepEqual(reasons.slice(0, 3), [
        'hdbscan:primary:1:0',
        'hdbscan:primary:2:0',
        'hdbscan:noise:4'
    ])
    assert.deepEqual(
        reasons.slice(3),
        Array.from(
            { length: 12 },
            (_, index) => `hdbscan:final-noise:chunk-${index + 1}`
        )
    )
    assert.ok(
        clusters.slice(3).every((cluster) => cluster.entries.length <= 30)
    )
    const clusteredIds = clusters.flatMap((cluster) =>
        cluster.entries.map((entry) => entry.id)
    )
    assert.equal(clusteredIds.length, entries.length)
    assert.equal(new Set(clusteredIds).size, entries.length)
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.round.started') &&
                message.includes('round=primary') &&
                message.includes('batches=2')
        )
    )
    const primaryBatches = captured.info.filter(
        (message) =>
            message.includes('event=dream.clustering.batch.completed') &&
            message.includes('round=primary')
    )
    assert.equal(primaryBatches.length, 2)
    assert.ok(
        primaryBatches.every((message) => message.includes('clusters-1=1'))
    )
    assert.ok(primaryBatches.some((message) => message.includes('noise=174')))
    assert.ok(primaryBatches.some((message) => message.includes('noise=175')))
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.round.completed') &&
                message.includes('round=primary') &&
                message.includes('totalNoise=349')
        )
    )
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.batch.completed') &&
                message.includes('round=global-noise') &&
                message.includes('clusters-1=3') &&
                message.includes('noise=346')
        )
    )
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.round.completed') &&
                message.includes('round=global-noise') &&
                message.includes('totalNoise=346')
        )
    )
    assert.ok(
        captured.info.every(
            (message) =>
                !message.includes('event=dream.clustering.progress') &&
                !message.includes('event=dream.clustering.partitioned')
        )
    )
})

it('reads first-pass partitions and global noise in bounded batches', async () => {
    const entries = createEntries(701)
    const partitions = partitionDreamEntries(entries)
    const vectors = createVectorReader(entries)
    const callSizes: number[] = []
    const worker = createDreamWorker(async (input, onProgress) => {
        assert.equal(onProgress, undefined)
        callSizes.push(input.entryCount)
        return new Int32Array(input.entryCount).fill(-1)
    })
    const clusterer = new DreamClusterer(vectors.reader, worker)

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries
    )

    assert.deepEqual(
        vectors.calls.map((ids) => ids.length),
        [...partitions.map((partition) => partition.length), 350, 350, 1]
    )
    assert.deepEqual(callSizes, [
        ...partitions.map((partition) => partition.length),
        701
    ])
    // 701 条 final-noise 兜底簇按 30 条上限切分为 24 个单元。
    assert.equal(clusters.length, 24)
    assert.ok(clusters.every((cluster) => cluster.entries.length <= 30))
    assert.deepEqual(
        clusters
            .map((cluster) => cluster.entries.length)
            .sort((left, right) => left - right),
        [...Array(19).fill(29), ...Array(5).fill(30)]
    )
    assert.equal(clusters[0].reason, 'hdbscan:final-noise:chunk-1')
    const clusteredIds = clusters.flatMap((cluster) =>
        cluster.entries.map((entry) => entry.id)
    )
    assert.equal(clusteredIds.length, entries.length)
    assert.equal(new Set(clusteredIds).size, entries.length)
})

it('skips the global noise pass when the first pass has no noise', async () => {
    const entries = createEntries(351)
    const vectors = createVectorReader(entries)
    const callSizes: number[] = []
    const worker = createDreamWorker(async (input) => {
        callSizes.push(input.entryCount)
        return new Int32Array(input.entryCount)
    })
    const captured = createCapturedLogger()
    const clusterer = new DreamClusterer(vectors.reader, worker)

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries,
        captured.logger
    )

    assert.deepEqual(
        [...callSizes].sort((left, right) => left - right),
        [175, 176]
    )
    assert.deepEqual(
        vectors.calls
            .map((ids) => ids.length)
            .sort((left, right) => left - right),
        [175, 176]
    )
    assert.equal(clusters.length, 12)
    assert.ok(clusters.every((cluster) => cluster.entries.length <= 30))
    assert.ok(
        clusters.every((cluster) =>
            cluster.reason.startsWith('hdbscan:primary:')
        )
    )
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.round.started') &&
                message.includes('round=global-noise') &&
                message.includes('batches=0')
        )
    )
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.round.completed') &&
                message.includes('round=global-noise') &&
                message.includes('totalNoise=0')
        )
    )
})

it('splits an oversized cluster into units within the size cap', async () => {
    const entries = createEntries(100)
    const vectors = createVectorReader(entries)
    const clusterer = new DreamClusterer(
        vectors.reader,
        createDreamWorker(async ({ entryCount }) => new Int32Array(entryCount))
    )

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries
    )

    assert.deepEqual(
        clusters.map((cluster) => cluster.id),
        [1, 2, 3, 4].map((index) => `cluster-1:chunk-${index}`)
    )
    assert.deepEqual(
        clusters.map((cluster) => cluster.reason),
        [1, 2, 3, 4].map((index) => `hdbscan:primary:1:0:chunk-${index}`)
    )
    assert.deepEqual(
        clusters.map((cluster) => cluster.entries.length),
        [25, 25, 25, 25]
    )
    for (const cluster of clusters) {
        const chunkIds = cluster.entries.map((entry) => entry.id)
        assert.deepEqual([...chunkIds].sort(), chunkIds)
    }
    const ids = clusters.flatMap((cluster) =>
        cluster.entries.map((entry) => entry.id)
    )
    assert.equal(ids.length, entries.length)
    assert.equal(new Set(ids).size, entries.length)
})

it('keeps clusters within the cap intact and splits oversized ones', async () => {
    const entries = createEntries(55)
    const vectors = createVectorReader(entries)
    const clusterer = new DreamClusterer(
        vectors.reader,
        createDreamWorker(async ({ entryCount }) =>
            Int32Array.from({ length: entryCount }, (_, index) =>
                index < 40 ? 0 : 1
            )
        )
    )

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries
    )

    assert.deepEqual(
        clusters
            .map((cluster) => cluster.entries.length)
            .sort((left, right) => right - left),
        [20, 20, 15]
    )
    assert.deepEqual(
        clusters
            .filter((cluster) => cluster.entries.length === 20)
            .map((cluster) => cluster.id),
        ['cluster-1:chunk-1', 'cluster-1:chunk-2']
    )
    assert.deepEqual(
        clusters
            .filter((cluster) => cluster.entries.length === 15)
            .map((cluster) => cluster.id),
        ['cluster-2']
    )
})

it('passes the unit size cap to partitioning only for oversized clusters', async () => {
    const entries = createEntries(55)
    const vectors = createVectorReader(entries)
    const partitionCalls: {
        entryCount: number
        targetSize: number | undefined
    }[] = []
    const worker: DreamWorkerRunner = {
        partition: async (clusterEntries, targetSize) => {
            partitionCalls.push({
                entryCount: clusterEntries.length,
                targetSize
            })
            return partitionDreamEntries(clusterEntries, { targetSize })
        },
        runHdbscan: async ({ entryCount }) =>
            Int32Array.from({ length: entryCount }, (_, index) =>
                index < 40 ? 0 : 1
            )
    }
    const clusterer = new DreamClusterer(vectors.reader, worker)

    await clusterer.buildClusters('preset-1', 'active', entries)

    assert.deepEqual(partitionCalls, [
        { entryCount: 55, targetSize: undefined },
        { entryCount: 40, targetSize: 30 }
    ])
})

it('logs a single first-pass noise entry without a global HDBSCAN run', async () => {
    const entries = createEntries(4)
    const vectors = createVectorReader(entries)
    const captured = createCapturedLogger()
    let hdbscanCalls = 0
    const clusterer = new DreamClusterer(
        vectors.reader,
        createDreamWorker(async () => {
            hdbscanCalls++
            return Int32Array.from([0, 0, 0, -1])
        })
    )

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries,
        captured.logger
    )

    assert.equal(hdbscanCalls, 1)
    assert.deepEqual(
        clusters.map((cluster) => cluster.entries.length),
        [3, 1]
    )
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.round.started') &&
                message.includes('round=global-noise') &&
                message.includes('batches=0')
        )
    )
    assert.ok(
        captured.info.some(
            (message) =>
                message.includes('event=dream.clustering.round.completed') &&
                message.includes('round=global-noise') &&
                message.includes('totalNoise=1')
        )
    )
})

it('propagates asynchronous HDBSCAN failures', async () => {
    const entries = createEntries(10)
    const vectors = createVectorReader(entries)
    const clusterer = new DreamClusterer(
        vectors.reader,
        createDreamWorker(async () => {
            throw new Error('Dream worker failed')
        })
    )

    await assert.rejects(
        clusterer.buildClusters('preset-1', 'active', entries),
        /Dream worker failed/u
    )
})

it('propagates asynchronous partition failures before reading vectors', async () => {
    const entries = createEntries(10)
    const vectors = createVectorReader(entries)
    const worker: DreamWorkerRunner = {
        partition: async () => {
            throw new Error('Dream partition worker failed')
        },
        runHdbscan: async () => {
            throw new Error('HDBSCAN must not run')
        }
    }
    const clusterer = new DreamClusterer(vectors.reader, worker)

    await assert.rejects(
        clusterer.buildClusters('preset-1', 'active', entries),
        /Dream partition worker failed/u
    )
    assert.deepEqual(vectors.calls, [])
})

it('emits batch summaries without worker progress callbacks', async () => {
    const entries = createEntries(4)
    const vectors = createVectorReader(entries)
    const captured = createCapturedLogger()
    const progressFlags: boolean[] = []
    const clusterer = new DreamClusterer(
        vectors.reader,
        createDreamWorker(async ({ entryCount }, onProgress) => {
            progressFlags.push(onProgress !== undefined)
            onProgress?.({
                phase: 'building-mst',
                completed: 2,
                total: 3,
                elapsedMs: 12
            })
            return new Int32Array(entryCount)
        })
    )

    await clusterer.buildClusters(
        'preset-1',
        'active',
        entries,
        captured.logger
    )

    assert.deepEqual(progressFlags, [false])
    assert.deepEqual(captured.info, [
        'event=dream.clustering.round.started ' +
            'stage=active round=primary batches=1',
        'event=dream.clustering.batch.completed ' +
            'stage=active round=primary batch=1 clusters-1=4 noise=0',
        'event=dream.clustering.round.completed ' +
            'stage=active round=primary totalNoise=0',
        'event=dream.clustering.round.started ' +
            'stage=active round=global-noise batches=0',
        'event=dream.clustering.round.completed ' +
            'stage=active round=global-noise totalNoise=0'
    ])
})
