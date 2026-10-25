import assert from 'node:assert/strict'
import type {
    DreamNeighborQuery,
    DreamVectorProvider
} from '../src/contracts/vector_index'
import { collectDreamCandidates } from '../src/service/workflows/dream/semantic/candidates'
import { createMemoryContentHash } from '../src/service/vector_index/hashes'
import { createMemoryEntry } from './workflow-test-utils'

const setup = () => {
    const entries = Array.from({ length: 61 }, (_, row) =>
        createMemoryEntry(`memory-${row}`)
    )
    const matrix = {
        entryCount: 61,
        dimension: 2,
        vectors: Float32Array.from({ length: 122 }, (_, i) => i + 1)
    }
    const provider: DreamVectorProvider = {
        readVectorSnapshot: async () => {
            throw new Error('candidate stage uses the frozen matrix')
        },
        queryDreamNeighbors: async () => {
            throw new Error('query fixture required')
        }
    }
    return {
        provider,
        presetId: 'preset',
        generation: 'generation',
        entries,
        matrix,
        initial: {
            labels: Uint32Array.from({ length: 61 }, (_, row) =>
                Math.floor(row / 30)
            ),
            sizes: new Uint32Array([30, 30, 1]),
            clusterCount: 3
        }
    }
}

it('reuses probe rows, resumes completed prefixes and retries short rows once against the snapshot', async () => {
    const input = setup()
    const calls = new Map<number, number>()
    const requestRows: number[] = []
    input.provider.queryDreamNeighbors = async (queries) => {
        assert.ok(queries.length <= 4)
        // 模拟真实 Worker 的所有权转移，包括本页尚未执行的查询副本。
        const transferred = structuredClone(queries, {
            transfer: queries.map((query) => query.vector.buffer)
        })
        const query: DreamNeighborQuery = transferred[0]
        const row = query.sourceIndex
        requestRows.push(row)
        assert.deepEqual(
            [...query.vector],
            [...input.matrix.vectors.slice(row * 2, row * 2 + 2)]
        )
        calls.set(row, (calls.get(row) ?? 0) + 1)
        const peers = input.entries.filter((_, index) => index !== row)
        const count = query.efSearch === 40 ? 5 : 10
        const valid = peers.slice(0, count).map((entry) => ({
            memoryId: entry.id,
            contentHash: createMemoryContentHash(entry.content)
        }))
        return {
            generation: 'generation',
            backend: 'hnsw',
            completed: 1,
            reason: 'budget',
            rows: [
                {
                    sourceIndex: row,
                    hits: [
                        ...valid,
                        valid[0],
                        {
                            memoryId: input.entries[row].id,
                            contentHash: createMemoryContentHash(
                                input.entries[row].content
                            )
                        },
                        {
                            memoryId: 'new-memory',
                            contentHash: 'new'
                        },
                        {
                            memoryId: peers[10].id,
                            contentHash: 'changed'
                        }
                    ]
                }
            ]
        }
    }
    const result = await collectDreamCandidates(input)
    assert.equal(result.stopReason, 'candidates-complete')
    assert.equal(result.queriedRows, 61)
    assert.equal(result.fullCandidateRows, 61)
    assert.equal(result.directedCandidateCount, 610)
    assert.ok(result.candidates)
    assert.ok(result.candidates.counts.every((count) => count === 10))
    assert.ok([...calls.values()].every((count) => count === 2))
    assert.deepEqual(requestRows.slice(0, 3), [0, 30, 60])
    assert.equal(input.matrix.vectors.length, 122)
})

it('stops on probe shortage or ANN unavailability and reports its completed coverage', async () => {
    for (const backend of ['hnsw', 'unavailable'] as const) {
        const input = setup()
        let calls = 0
        input.provider.queryDreamNeighbors = async (queries) => {
            calls++
            const completedQueries = backend === 'hnsw' ? queries : []
            return {
                generation: 'generation',
                backend,
                completed: backend === 'hnsw' ? queries.length : 0,
                reason: backend === 'unavailable' ? 'plan-exact' : undefined,
                rows: completedQueries.map((query) => ({
                    sourceIndex: query.sourceIndex,
                    hits: []
                }))
            }
        }
        const result = await collectDreamCandidates(input)
        assert.equal(result.candidates, undefined)
        assert.equal(
            result.stopReason,
            backend === 'hnsw' ? 'candidate-short' : 'plan-exact'
        )
        assert.ok(result.queriedRows <= 32)
        assert.ok(calls <= 16)
    }
})

it('propagates cancellation, generation changes and provider failures', async () => {
    const input = setup()
    input.provider.queryDreamNeighbors = async () => ({
        generation: 'changed',
        backend: 'unavailable',
        completed: 0,
        rows: [],
        reason: 'index-absent'
    })
    await assert.rejects(collectDreamCandidates(input), /代际已变化/u)
    input.provider.queryDreamNeighbors = async () => {
        throw new Error('worker failure')
    }
    await assert.rejects(collectDreamCandidates(input), /worker failure/u)
    const controller = new AbortController()
    let calls = 0
    input.provider.queryDreamNeighbors = async (queries) => {
        calls++
        controller.abort(new Error('user cancellation'))
        return {
            generation: 'generation',
            backend: 'hnsw',
            completed: queries.length,
            rows: queries.map((query) => ({
                sourceIndex: query.sourceIndex,
                hits: []
            }))
        }
    }
    await assert.rejects(
        collectDreamCandidates({ ...input, signal: controller.signal }),
        /user cancellation/u
    )
    assert.equal(calls, 1)
})
