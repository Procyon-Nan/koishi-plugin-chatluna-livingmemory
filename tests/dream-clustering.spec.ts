import assert from 'node:assert/strict'
import type { ManualDreamVectorReader } from '../src/contracts/vector_index'
import { DreamClusterer } from '../src/service/workflows/dream/clustering'
import type { DreamHdbscanRunner } from '../src/service/workflows/dream/hdbscan/protocol'
import {
    buildDreamPartitionTargetSizes,
    partitionDreamEntries,
    selectDreamPartitionCount
} from '../src/service/workflows/dream/partitioning'
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
    const hdbscan: DreamHdbscanRunner = {
        run: async (input, reportProgress) => {
            assert.equal(input.dimension, 2)
            assert.equal(input.vectors.length, input.entryCount * 2)
            assert.equal(reportProgress, false)
            callSizes.push(input.entryCount)
            if (callSizes.length <= partitions.length) {
                return Int32Array.from(
                    { length: input.entryCount },
                    (_, index) => (index === 0 ? 0 : -1)
                )
            }
            return Int32Array.from(
                { length: input.entryCount },
                (_, index) => (index < 3 ? 4 : -1)
            )
        }
    }
    const clusterer = new DreamClusterer(
        vectors.reader,
        () => {},
        false,
        hdbscan
    )

    const clusters = await clusterer.buildClusters('preset-1', entries)

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
})

it('reads first-pass partitions and global noise in bounded batches', async () => {
    const entries = createEntries(701)
    const partitions = partitionDreamEntries(entries)
    const vectors = createVectorReader(entries)
    const callSizes: number[] = []
    const hdbscan: DreamHdbscanRunner = {
        run: async (input) => {
            callSizes.push(input.entryCount)
            return new Int32Array(input.entryCount).fill(-1)
        }
    }
    const clusterer = new DreamClusterer(
        vectors.reader,
        () => {},
        false,
        hdbscan
    )

    const clusters = await clusterer.buildClusters('preset-1', entries)

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
    const hdbscan: DreamHdbscanRunner = {
        run: async (input) => {
            callSizes.push(input.entryCount)
            return new Int32Array(input.entryCount)
        }
    }
    const clusterer = new DreamClusterer(
        vectors.reader,
        () => {},
        false,
        hdbscan
    )

    const clusters = await clusterer.buildClusters('preset-1', entries)

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
})

it('propagates asynchronous HDBSCAN failures', async () => {
    const entries = createEntries(10)
    const vectors = createVectorReader(entries)
    const clusterer = new DreamClusterer(
        vectors.reader,
        () => {},
        false,
        {
            run: async () => {
                throw new Error('Dream worker failed')
            }
        }
    )

    await assert.rejects(
        clusterer.buildClusters('preset-1', entries),
        /Dream worker failed/u
    )
})

it('enables worker progress and completion logs only for debug tracing', async () => {
    const entries = createEntries(4)
    const vectors = createVectorReader(entries)
    const debugMessages: string[] = []
    const progressFlags: boolean[] = []
    const clusterer = new DreamClusterer(
        vectors.reader,
        (message) => debugMessages.push(message),
        true,
        {
            run: async ({ entryCount }, reportProgress) => {
                progressFlags.push(reportProgress)
                return new Int32Array(entryCount)
            }
        }
    )

    await clusterer.buildClusters('preset-1', entries)

    assert.deepEqual(progressFlags, [true])
    assert.ok(
        debugMessages.some((message) =>
            message.includes(
                'entries=4 dimension=2 mstEdges=3 clusters=1 noise=0'
            )
        )
    )
})
