import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import { buildAutomaticDreamClustersFromVectors } from '../src/service/workflows/dream/automatic_clustering'
import { DreamClusterer } from '../src/service/workflows/dream/clustering'
import type { DreamHdbscanRunner } from '../src/service/workflows/dream/hdbscan'
import { buildManualDreamClustersFromVectors } from '../src/service/workflows/dream/manual_clustering'
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

it('runs one global HDBSCAN pass over all first-pass noise', () => {
    const entries = createEntries(351)
    const partitions = partitionDreamEntries(entries)
    const vectorById = new Map(
        entries.map((entry, index) => [entry.id, [index + 1, 1]])
    )
    const callSizes: number[] = []
    const runHdbscan: DreamHdbscanRunner = (vectors) => {
        callSizes.push(vectors.length)
        if (callSizes.length <= partitions.length) {
            return {
                labels: vectors.map((_, index) => (index === 0 ? 0 : -1)),
                probabilities: vectors.map(() => 1)
            }
        }
        return {
            labels: vectors.map((_, index) => (index < 3 ? 4 : -1)),
            probabilities: vectors.map(() => 1)
        }
    }

    const clusters = buildManualDreamClustersFromVectors(
        partitions,
        vectorById,
        runHdbscan
    )

    assert.deepEqual([...callSizes.slice(0, 2)].sort(), [175, 176])
    assert.equal(callSizes[2], 349)
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

it('skips the global noise pass when the first pass has no noise', () => {
    const entries = createEntries(351)
    const partitions = partitionDreamEntries(entries)
    const vectorById = new Map(
        entries.map((entry, index) => [entry.id, [index + 1, 1]])
    )
    const callSizes: number[] = []
    const runHdbscan: DreamHdbscanRunner = (vectors) => {
        callSizes.push(vectors.length)
        return {
            labels: vectors.map(() => 0),
            probabilities: vectors.map(() => 1)
        }
    }

    const clusters = buildManualDreamClustersFromVectors(
        partitions,
        vectorById,
        runHdbscan
    )

    assert.deepEqual(
        [...callSizes].sort((left, right) => left - right),
        [175, 176]
    )
    assert.equal(clusters.length, 2)
})

it('routes manual and automatic Dream through their distinct clustering paths', async () => {
    const createClusterer = (callSizes: number[]) => {
        const ctx = {
            chatluna: {
                createEmbeddings: async () => ({
                    value: {
                        embedQuery: async () => [1, 1],
                        embedDocuments: async () => {
                            throw new Error('cached vectors should be reused')
                        }
                    }
                })
            },
            logger: () => ({ warn: () => {} })
        } as unknown as Context
        const runHdbscan: DreamHdbscanRunner = (vectors) => {
            callSizes.push(vectors.length)
            return {
                labels: vectors.map(() => 0),
                probabilities: vectors.map(() => 1)
            }
        }
        return new DreamClusterer(
            ctx,
            { embeddingModel: 'embedding-model' },
            { updateEntryEmbeddings: async () => {} },
            () => {},
            runHdbscan
        )
    }
    const entries = createEntries(351).map((entry, index) => ({
        ...entry,
        embedding: [index + 1, 1],
        embeddingModelId: 'embedding-model'
    }))
    const manualCallSizes: number[] = []
    const automaticCallSizes: number[] = []

    await createClusterer(manualCallSizes).buildClusters(entries, 'manual')
    await createClusterer(automaticCallSizes).buildClusters(entries, 'auto')

    assert.deepEqual(
        [...manualCallSizes].sort((left, right) => left - right),
        [175, 176]
    )
    assert.deepEqual(automaticCallSizes, [351])
})

it('keeps the final single-entry chunk in automatic Dream', () => {
    const entries = createEntries(9)
    const vectorById = new Map(
        entries.map((entry, index) => [entry.id, [index + 1, 1]])
    )
    const clusters = buildAutomaticDreamClustersFromVectors(
        entries,
        vectorById,
        () => {},
        (vectors) => ({
            labels: vectors.map(() => 0),
            probabilities: vectors.map(() => 1)
        })
    )

    assert.deepEqual(
        clusters.map((cluster) => cluster.entries.length),
        [8, 1]
    )
    assert.equal(
        new Set(
            clusters.flatMap((cluster) =>
                cluster.entries.map((entry) => entry.id)
            )
        ).size,
        entries.length
    )
})

it('fails Dream when an entry embedding is invalid', async () => {
    const entries = createEntries(2)
    const ctx = {
        chatluna: {
            createEmbeddings: async () => ({
                value: {
                    embedQuery: async () => [1, 0],
                    embedDocuments: async () => [[1, 0], []]
                }
            })
        },
        logger: () => ({ warn: () => {} })
    } as unknown as Context
    const clusterer = new DreamClusterer(
        ctx,
        { embeddingModel: 'embedding-model' },
        { updateEntryEmbeddings: async () => {} },
        () => {}
    )

    await assert.rejects(
        clusterer.buildClusters(entries, 'manual'),
        /dream embedding invalid/u
    )
})
