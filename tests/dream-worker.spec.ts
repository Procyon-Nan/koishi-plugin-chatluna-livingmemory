import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bisectDreamMemories } from '../src/service/workflows/dream/semantic/bisect'
import { refineDreamMemories } from '../src/service/workflows/dream/semantic/refine'
import {
    dreamCandidateWidth,
    type DreamVectorMatrix
} from '../src/service/workflows/dream/semantic/types'
import { validateDreamPlan } from '../src/service/workflows/dream/semantic/validate'
import { LivingMemoryDreamWorkerClient } from '../src/service/workflows/dream/worker/client'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client'
import { dreamWorkerPath, vectorIndexWorkerPath } from './worker-test-utils'

const createBisectInput = (matrix: DreamVectorMatrix) => ({
    matrix,
    cancellation: new SharedArrayBuffer(4),
    budgetMs: 30_000
})

const createMatrix = (rows: number[][]): DreamVectorMatrix => ({
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

it.each([0, 20_000])(
    'transfers refinement inputs and retains the main-thread checkpoint (budget=%i)',
    async (budgetMs) => {
        const client = new LivingMemoryDreamWorkerClient({
            workerPath: dreamWorkerPath
        })
        await client.start()
        try {
            const checkpoint = Uint32Array.from({ length: 60 }, (_, row) =>
                Math.floor(row / 30)
            )
            const neighbors = new Uint32Array(60 * dreamCandidateWidth)
            for (let row = 0; row < 60; row++) {
                neighbors.set(
                    Array.from({ length: 60 }, (_, i) => i).filter(
                        (i) => i !== row
                    ),
                    row * dreamCandidateWidth
                )
            }
            const input = {
                matrix: createMatrix(
                    Array.from({ length: 60 }, (_, row) =>
                        row % 2 === 0 ? [1, 0] : [0, 1]
                    )
                ),
                initial: {
                    labels: checkpoint.slice(),
                    sizes: new Uint32Array([30, 30]),
                    clusterCount: 2
                },
                candidates: {
                    q: 10,
                    counts: new Uint8Array(60).fill(59),
                    neighbors
                },
                cancellation: new SharedArrayBuffer(4),
                budgetMs
            }
            const expected = refineDreamMemories(structuredClone(input))
            const result = await client.refine(input)
            for (const array of [
                input.matrix.vectors,
                input.initial.labels,
                input.initial.sizes,
                input.candidates.counts,
                input.candidates.neighbors
            ]) {
                assert.equal(array.byteLength, 0)
            }
            assert.equal(checkpoint.length, 60)
            assert.equal(result.outcome, expected.outcome)
            if (
                result.outcome === 'refined' &&
                expected.outcome === 'refined'
            ) {
                validateDreamPlan(result.plan, 60)
                assert.deepEqual(result.plan, expected.plan)
            }
        } finally {
            await client.stop()
        }
    }
)

it('starts both workers from source-loaded default paths', async () => {
    const dreamClient = new LivingMemoryDreamWorkerClient()
    await dreamClient.start()
    await dreamClient.stop()

    const vectorIndexClient = new LivingMemoryVectorIndexWorkerClient()
    await vectorIndexClient.dispose()
})

it('transfers the bisect matrix back with a complete capacity plan', async () => {
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()
    try {
        const matrix = createMatrix(
            Array.from({ length: 61 }, (_, i) => [i + 1, 1])
        )
        const original = new Float32Array(matrix.vectors)
        const input = {
            matrix,
            cancellation: new SharedArrayBuffer(4),
            budgetMs: 30_000
        }
        const expected = bisectDreamMemories({
            ...input,
            matrix: { ...matrix, vectors: original }
        })
        const result = await client.bisect(input)
        assert.equal(matrix.vectors.byteLength, 0)
        assert.deepEqual(result.matrix.vectors, original)
        assert.deepEqual(result.plan, expected.plan)
        validateDreamPlan(result.plan, 61)
    } finally {
        await client.stop()
    }
})

it('observes the shared cancellation flag and remains usable', async () => {
    const client = new LivingMemoryDreamWorkerClient({
        workerPath: dreamWorkerPath
    })
    await client.start()
    try {
        const cancellation = new SharedArrayBuffer(4)
        Atomics.store(new Int32Array(cancellation), 0, 1)
        await assert.rejects(
            client.bisect({
                matrix: createMatrix([[1, 0]]),
                cancellation,
                budgetMs: 30_000
            }),
            /已取消/
        )
        const result = await client.bisect({
            matrix: createMatrix([[1, 0]]),
            cancellation: new SharedArrayBuffer(4),
            budgetMs: 30_000
        })
        assert.deepEqual([...result.plan.sizes], [1])
    } finally {
        await client.stop()
    }
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
    const clustering = client
        .bisect(createBisectInput(createMatrix(rows)))
        .then(() => {
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
        client.bisect(createBisectInput(createMatrix([[0, 0]]))),
        /有限正范数/
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
        client.bisect(createBisectInput(createMatrix(rows))),
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
        client.bisect(createBisectInput(createMatrix([[1, 0]]))),
        /Cannot find module|cannot find module/
    )
    await client.stop()
})
