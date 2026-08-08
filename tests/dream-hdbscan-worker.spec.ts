import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
    runDreamHdbscan,
    type DreamHdbscanMatrix
} from '../src/service/workflows/dream/hdbscan/algorithm'
import { LivingMemoryDreamHdbscanWorkerClient } from '../src/service/workflows/dream/hdbscan/worker_client'
import type { DreamHdbscanWorkerProgress } from '../src/service/workflows/dream/hdbscan/protocol'
import {
    dreamHdbscanWorkerPath,
    ensureWorkersBuilt,
    vectorIndexWorkerPath
} from './worker-test-utils'

const createMatrix = (rows: number[][]): DreamHdbscanMatrix => ({
    entryCount: rows.length,
    dimension: rows[0]?.length ?? 0,
    vectors: new Float32Array(rows.flat())
})

before(async () => {
    await ensureWorkersBuilt()
})

it('builds both worker artifacts through the shared build script', async () => {
    for (const workerPath of [vectorIndexWorkerPath, dreamHdbscanWorkerPath]) {
        const worker = await stat(workerPath)
        assert.equal(worker.isFile(), true)
        assert.ok(worker.size > 0)
    }

    const dreamWorker = await readFile(dreamHdbscanWorkerPath, 'utf8')
    assert.equal(dreamWorker.includes('better-sqlite3'), false)
    assert.equal(dreamWorker.includes('sqlite-vec'), false)
})

it('starts the Dream worker and transfers vectors and labels', async () => {
    const client = new LivingMemoryDreamHdbscanWorkerClient({
        workerPath: dreamHdbscanWorkerPath
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

    const labels = await client.run(matrix, false)

    assert.equal(matrix.vectors.byteLength, 0)
    assert.deepEqual([...labels], [...expected])
    assert.ok(labels.buffer.byteLength > 0)
    await client.stop()
})

it('reports progress only for requests that enable it', async () => {
    const progress: DreamHdbscanWorkerProgress[] = []
    const client = new LivingMemoryDreamHdbscanWorkerClient({
        workerPath: dreamHdbscanWorkerPath,
        onProgress: (update) => progress.push(update)
    })
    await client.start()
    const rows = Array.from({ length: 64 }, (_, index) => [
        Math.cos(index),
        Math.sin(index),
        1
    ])

    await client.run(createMatrix(rows), false)
    assert.deepEqual(progress, [])

    await client.run(createMatrix(rows), true)
    const phases = progress.map(({ phase }) => phase)
    assert.ok(phases.includes('normalizing'))
    assert.ok(phases.includes('building-mst'))
    assert.ok(phases.includes('building-hierarchy'))
    assert.ok(phases.includes('selecting-clusters'))
    assert.equal(new Set(progress.map(({ requestId }) => requestId)).size, 1)
    assert.ok(progress.every(({ elapsedMs }) => elapsedMs >= 0))
    assert.ok(progress.length < 40)
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
    const client = new LivingMemoryDreamHdbscanWorkerClient({
        workerPath: dreamHdbscanWorkerPath
    })
    await client.start()

    let completed = false
    const clustering = client.run(createMatrix(rows), false).then(() => {
        completed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(completed, false)
    await clustering
    await client.stop()
})

it('returns worker algorithm errors to the caller', async () => {
    const client = new LivingMemoryDreamHdbscanWorkerClient({
        workerPath: dreamHdbscanWorkerPath
    })
    await client.start()

    await assert.rejects(
        client.run(
            {
                entryCount: 3,
                dimension: 2,
                vectors: new Float32Array(5)
            },
            false
        ),
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
    const client = new LivingMemoryDreamHdbscanWorkerClient({
        workerPath: dreamHdbscanWorkerPath
    })
    await client.start()

    const rejection = assert.rejects(
        client.run(createMatrix(rows), false),
        /worker stopped/
    )
    await client.stop()
    await rejection
})

it('rejects startup and later requests when the worker is unavailable', async () => {
    const client = new LivingMemoryDreamHdbscanWorkerClient({
        workerPath: resolve(__dirname, 'missing-dream-hdbscan-worker.mjs')
    })

    await assert.rejects(
        client.start(),
        /Cannot find module|cannot find module/
    )
    await assert.rejects(
        client.run(createMatrix([[1, 0]]), false),
        /Cannot find module|cannot find module/
    )
    await client.stop()
})
