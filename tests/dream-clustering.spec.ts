import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import {
    buildManualDreamClustersFromVectors,
    DreamClusterer,
    type DreamHdbscanRunner
} from '../src/service/workflows/dream/clustering'
import {
    partitionDreamEntries,
    selectDreamPartitionCount
} from '../src/service/workflows/dream/partitioning'
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
