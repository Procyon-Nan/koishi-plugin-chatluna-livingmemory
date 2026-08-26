import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
    runDreamHdbscan,
    type DreamHdbscanMatrix
} from '../src/service/workflows/dream/hdbscan/algorithm'
import { partitionDreamEntries } from '../src/service/workflows/dream/partitioning'
import { LivingMemoryDreamWorkerClient } from '../src/service/workflows/dream/worker/client'
import type { DreamHdbscanProgress } from '../src/service/workflows/dream/worker/protocol'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client'
import { dreamWorkerPath, vectorIndexWorkerPath } from './worker-test-utils'

const createMatrix = (rows: number[][]): DreamHdbscanMatrix => ({
    entryCount: rows.length,
    dimension: rows[0]?.length ?? 0,
    vectors: new Float32Array(rows.flat())
})

it('builds both worker artifacts through the shared build script', async () => {
    for (const workerPath of [vectorIndexWorkerPath, dreamWorkerPath]) {
        const worker = await stat(workerPath)
        assert.equal(worker.isFile(), true)
        assert.ok(worker.size > 0)
    }

    const dreamWorker = await readFile(dreamWorkerPath, 'utf8')
    assert.equal(dreamWorker.includes('better-sqlite3'), false)
    assert.equal(dreamWorker.includes('sqlite-vec'), false)
})

it('starts both workers from source-loaded default paths', async () => {
    const dreamClient = new LivingMemoryDreamWorkerClient()
    await dreamClient.start()
    await dreamClient.stop()

    const vectorIndexClient = new LivingMemoryVectorIndexWorkerClient()
    await vectorIndexClient.dispose()
})

it('starts the Dream worker and transfers vectors and labels', async () => {
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()
    const matrix = createMatrix([
        [1, 0],
        [0.99, 0.01],
        [0, 1],
        [0.01, 0.99],
        [-1, 0]
    ])
    const expected = runDreamHdbscan({
        ...matrix,
        vectors: new Float32Array(matrix.vectors)
    })

    const labels = await client.runHdbscan(matrix)

    assert.equal(matrix.vectors.byteLength, 0)
    assert.deepEqual([...labels], [...expected])
    assert.ok(labels.buffer.byteLength > 0)
    await client.stop()
})

it('partitions entries without cloning full memory records', async () => {
    const entries = Array.from({ length: 720 }, (_, index) => ({
        id: `memory-${index.toString().padStart(4, '0')}`,
        keywords: [`group-${index % 8}`, `topic-${index % 23}`],
        content: `content-${index}`
    }))
    const expected = partitionDreamEntries(entries).map((partition) =>
        partition.map((entry) => entry.id)
    )
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()

    const partitions = await client.partition(entries)

    assert.deepEqual(
        partitions.map((partition) => partition.map((entry) => entry.id)),
        expected
    )
    assert.ok(
        partitions.every((partition) =>
            partition.every((entry) => entries.includes(entry))
        )
    )
    await client.stop()
})

it('partitions with an explicit target size through the worker', async () => {
    const entries = Array.from({ length: 95 }, (_, index) => ({
        id: `memory-${index.toString().padStart(4, '0')}`,
        keywords: [`group-${index % 8}`, `topic-${index % 23}`]
    }))
    const expected = partitionDreamEntries(entries, {
        targetSize: 30
    }).map((partition) => partition.map((entry) => entry.id))
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()

    const partitions = await client.partition(entries, 30)

    assert.deepEqual(
        partitions.map((partition) => partition.map((entry) => entry.id)),
        expected
    )
    assert.equal(partitions.length, 4)
    assert.ok(
        partitions.every(
            (partition) => partition.length <= 30 && partition.length > 0
        )
    )
    assert.equal(partitions.flat().length, entries.length)
    await client.stop()
})

it('keeps the main event loop responsive during partitioning', async () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
        id: `memory-${index.toString().padStart(4, '0')}`,
        keywords: [`group-${index % 8}`, `topic-${index % 23}`]
    }))
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()

    let completed = false
    const partitioning = client.partition(entries).then((partitions) => {
        completed = true
        return partitions
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(completed, false)
    const partitions = await partitioning
    assert.equal(partitions.length, 17)
    assert.equal(partitions.flat().length, entries.length)
    assert.ok(partitions.every((partition) => partition.length <= 350))
    await client.stop()
})

it('reports progress only for requests that enable it', async () => {
    const progress = new Array<DreamHdbscanProgress>()
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()
    const rows = Array.from({ length: 64 }, (_, index) => [
        Math.cos(index),
        Math.sin(index),
        1
    ])

    await client.runHdbscan(createMatrix(rows))
    assert.equal(progress.length, 0)

    await client.runHdbscan(
        createMatrix(rows),
        (update: DreamHdbscanProgress) => {
            progress.push(update)
        }
    )
    const phases: DreamHdbscanProgress['phase'][] = progress.map(
        ({ phase }) => phase
    )
    assert.ok(phases.includes('normalizing'))
    assert.ok(phases.includes('building-mst'))
    assert.ok(phases.includes('building-hierarchy'))
    assert.ok(phases.includes('selecting-clusters'))
    assert.ok(progress.every(({ elapsedMs }) => elapsedMs >= 0))
    assert.ok(progress.length < 40)
    await client.stop()
})

it('routes progress to the callback for each concurrent request', async () => {
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()
    const createRows = (count: number) =>
        Array.from({ length: count }, (_, index) => [
            Math.cos(index),
            Math.sin(index),
            1
        ])
    const firstProgress: DreamHdbscanProgress[] = []
    const secondProgress: DreamHdbscanProgress[] = []

    await Promise.all([
        client.runHdbscan(createMatrix(createRows(48)), (update) =>
            firstProgress.push(update)
        ),
        client.runHdbscan(createMatrix(createRows(72)), (update) =>
            secondProgress.push(update)
        )
    ])

    assert.ok(firstProgress.length > 0)
    assert.ok(secondProgress.length > 0)
    const firstNormalizing = firstProgress.filter(
        ({ phase }) => phase === 'normalizing'
    )
    const secondNormalizing = secondProgress.filter(
        ({ phase }) => phase === 'normalizing'
    )
    assert.ok(firstNormalizing.length > 0)
    assert.ok(secondNormalizing.length > 0)
    assert.ok(firstNormalizing.every(({ total }) => total === 48))
    assert.ok(secondNormalizing.every(({ total }) => total === 72))
    await client.stop()
})

it('keeps the main event loop responsive during clustering', async () => {
    let state = 0x12345678
    const random = () => {
        state = (1664525 * state + 1013904223) >>> 0
        return state / 0x1_0000_0000
    }
    const rows = Array.from({ length: 1200 }, () =>
        Array.from({ length: 32 }, random)
    )
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()

    let completed = false
    const clustering = client.runHdbscan(createMatrix(rows)).then(() => {
        completed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(completed, false)
    await clustering
    await client.stop()
})

it('returns worker algorithm errors to the caller', async () => {
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()

    await assert.rejects(
        client.runHdbscan({
            entryCount: 3,
            dimension: 2,
            vectors: new Float32Array(5)
        }),
        /matrix shape mismatch/
    )
    await client.stop()
})

it('rejects active requests when the worker stops', async () => {
    const rows = Array.from({ length: 800 }, (_, index) => [
        Math.cos(index),
        Math.sin(index),
        index % 17
    ])
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()

    const rejection = assert.rejects(
        client.runHdbscan(createMatrix(rows)),
        /worker stopped/
    )
    await client.stop()
    await rejection
})

it('rejects startup and later requests when the worker is unavailable', async () => {
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: fileURLToPath(
            new URL('missing-dream-worker.mjs', import.meta.url)
        )
    })

    await assert.rejects(
        client.start(),
        /Cannot find module|cannot find module/
    )
    await assert.rejects(
        client.runHdbscan(createMatrix([[1, 0]])),
        /Cannot find module|cannot find module/
    )
    await client.stop()
})
