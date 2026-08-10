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
import { createMemoryEntry } from './workflow-test-utils'

const createEntries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
        ...createMemoryEntry(`memory-${index.toString().padStart(4, '0')}`),
        keywords: [`group-${index % 8}`, `topic-${index % 23}`]
    }))

const createDreamWorker = (
    runHdbscan: DreamWorkerRunner['runHdbscan']
): DreamWorkerRunner => ({
    partition: async (entries) => partitionDreamEntries(entries),
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
    const debugMessages: string[] = []
    const worker = createDreamWorker(async (input, onProgress) => {
        assert.equal(input.dimension, 2)
        assert.equal(input.vectors.length, input.entryCount * 2)
        assert.equal(typeof onProgress, 'function')
        callSizes.push(input.entryCount)
        if (callSizes.length <= partitions.length) {
            return Int32Array.from(
                { length: input.entryCount },
                (_, index) => (index === 0 ? 0 : -1)
            )
        }
        onProgress?.({
            phase: 'building-mst',
            completed: 120,
            total: 348,
            elapsedMs: 25
        })
        return Int32Array.from(
            { length: input.entryCount },
            (_, index) => (index < 3 ? 4 : -1)
        )
    })
    const clusterer = new DreamClusterer(
        vectors.reader,
        (message) => debugMessages.push(message),
        true,
        worker
    )

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries
    )

    assert.deepEqual([...callSizes.slice(0, 2)].sort(), [175, 176])
    assert.equal(callSizes[2], 349)
    assert.deepEqual(
        vectors.calls.map((ids) => ids.length),
        [175, 176, 349]
    )
    assert.deepEqual(
        clusters.map((cluster) => cluster.reason),
        [
            'hdbscan:primary:1:0',
            'hdbscan:primary:2:0',
            'hdbscan:noise:4',
            'hdbscan:final-noise'
        ]
    )
    const clusteredIds = clusters.flatMap((cluster) =>
        cluster.entries.map((entry) => entry.id)
    )
    assert.equal(clusteredIds.length, entries.length)
    assert.equal(new Set(clusteredIds).size, entries.length)
    assert.ok(
        debugMessages.includes(
            'memory dream clustering partitioned: presetId=preset-1 ' +
                'stage=active entries=351 partitions=2 ' +
                'partitionSizes=[175,176]'
        )
    )
    assert.ok(
        debugMessages.some((message) =>
            message.includes(
                'stage=active partition=1/2 entries=175 clusters=1 ' +
                    'clusterSizes=[0:1] noise=174 dimension=2'
            )
        )
    )
    assert.ok(
        debugMessages.some((message) =>
            message.includes(
                'memory dream clustering global-noise completed: ' +
                    'presetId=preset-1 stage=active entries=349 ' +
                    'clusters=1 clusterSizes=[4:3] finalNoise=346 dimension=2'
            )
        )
    )
    assert.ok(
        debugMessages.includes(
            'memory dream clustering progress: presetId=preset-1 ' +
                'stage=active pass=global-noise entries=349 ' +
                'phase=building-mst completed=120 total=348 ' +
                'percent=34 elapsedMs=25'
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
    const clusterer = new DreamClusterer(
        vectors.reader,
        () => {},
        false,
        worker
    )

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
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].entries.length, entries.length)
})

it('skips the global noise pass when the first pass has no noise', async () => {
    const entries = createEntries(351)
    const vectors = createVectorReader(entries)
    const callSizes: number[] = []
    const worker = createDreamWorker(async (input) => {
        callSizes.push(input.entryCount)
        return new Int32Array(input.entryCount)
    })
    const debugMessages: string[] = []
    const clusterer = new DreamClusterer(
        vectors.reader,
        (message) => debugMessages.push(message),
        true,
        worker
    )

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries
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
    assert.equal(clusters.length, 2)
    assert.ok(
        debugMessages.includes(
            'memory dream clustering global-noise completed: ' +
                'presetId=preset-1 stage=active entries=0 hdbscan=skipped ' +
                'clusters=0 clusterSizes=[] finalNoise=0'
        )
    )
})

it('logs a single first-pass noise entry without a global HDBSCAN run', async () => {
    const entries = createEntries(4)
    const vectors = createVectorReader(entries)
    const debugMessages: string[] = []
    let hdbscanCalls = 0
    const clusterer = new DreamClusterer(
        vectors.reader,
        (message) => debugMessages.push(message),
        true,
        createDreamWorker(async () => {
            hdbscanCalls++
            return Int32Array.from([0, 0, 0, -1])
        })
    )

    const clusters = await clusterer.buildClusters(
        'preset-1',
        'active',
        entries
    )

    assert.equal(hdbscanCalls, 1)
    assert.deepEqual(
        clusters.map((cluster) => cluster.entries.length),
        [3, 1]
    )
    assert.ok(
        debugMessages.includes(
            'memory dream clustering global-noise completed: ' +
                'presetId=preset-1 stage=active entries=1 hdbscan=skipped ' +
                'clusters=0 clusterSizes=[] finalNoise=1'
        )
    )
})

it('propagates asynchronous HDBSCAN failures', async () => {
    const entries = createEntries(10)
    const vectors = createVectorReader(entries)
    const clusterer = new DreamClusterer(
        vectors.reader,
        () => {},
        false,
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
    const clusterer = new DreamClusterer(
        vectors.reader,
        () => {},
        false,
        worker
    )

    await assert.rejects(
        clusterer.buildClusters('preset-1', 'active', entries),
        /Dream partition worker failed/u
    )
    assert.deepEqual(vectors.calls, [])
})

it('enables worker progress and completion logs only for debug logging', async () => {
    const entries = createEntries(4)
    const vectors = createVectorReader(entries)
    const debugMessages: string[] = []
    const progressFlags: boolean[] = []
    const clusterer = new DreamClusterer(
        vectors.reader,
        (message) => debugMessages.push(message),
        true,
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

    await clusterer.buildClusters('preset-1', 'active', entries)

    assert.deepEqual(progressFlags, [true])
    assert.ok(
        debugMessages.includes(
            'memory dream clustering progress: presetId=preset-1 ' +
                'stage=active pass=primary partition=1/1 entries=4 ' +
                'phase=building-mst completed=2 total=3 percent=67 elapsedMs=12'
        )
    )
    assert.ok(
        debugMessages.some((message) =>
            message.includes(
                'stage=active partition=1/1 entries=4 clusters=1 ' +
                    'clusterSizes=[0:4] noise=0 dimension=2'
            )
        )
    )
})
