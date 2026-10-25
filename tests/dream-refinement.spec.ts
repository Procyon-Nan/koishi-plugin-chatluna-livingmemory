import assert from 'node:assert/strict'
import {
    buildDreamGraph,
    calculateDreamGraphObjective
} from '../src/service/workflows/dream/semantic/graph'
import {
    refineDreamPlan,
    refineDreamMemories
} from '../src/service/workflows/dream/semantic/refine'
import {
    dreamCandidateWidth,
    type DreamCandidates,
    type DreamPlanLabels,
    type DreamSparseGraph
} from '../src/service/workflows/dream/semantic/types'
import { validateDreamPlan } from '../src/service/workflows/dream/semantic/validate'

const candidatesFor = (n: number): DreamCandidates => {
    const neighbors = new Uint32Array(n * dreamCandidateWidth)
    for (let row = 0; row < n; row++) {
        const peers = Array.from({ length: n }, (_, i) => i).filter(
            (i) => i !== row
        )
        neighbors.set(peers, row * dreamCandidateWidth)
    }
    return {
        q: Math.min(10, n - 1),
        counts: new Uint8Array(n).fill(n - 1),
        neighbors
    }
}

const fullGroupsInput = () => ({
    matrix: {
        entryCount: 60,
        dimension: 2,
        vectors: Float32Array.from({ length: 120 }, (_, i) =>
            (Math.floor(i / 2) % 2 === 0) === (i % 2 === 0) ? 1 : 0
        )
    },
    initial: {
        labels: Uint32Array.from({ length: 60 }, (_, i) => Math.floor(i / 30)),
        sizes: new Uint32Array([30, 30]),
        clusterCount: 2
    },
    candidates: candidatesFor(60),
    cancellation: new SharedArrayBuffer(4)
})

it('improves full groups through swaps and preserves capacity and coverage', () => {
    const result = refineDreamMemories(fullGroupsInput())
    assert.equal(result.outcome, 'refined')
    if (result.outcome !== 'refined') assert.fail('expected complete graph')
    validateDreamPlan(result.plan, 60)
    assert.ok(result.diagnostics.acceptedSwaps > 0)
    assert.equal(result.diagnostics.acceptedMoves, 0)
    assert.ok(
        result.diagnostics.finalObjective! >
            result.diagnostics.initialObjective!
    )
    assert.ok(result.diagnostics.edgeVisits <= 100 * 60 * 10)
    assert.ok(result.diagnostics.hintEdgeVisits <= 3 * 60 * 3 * 30 * 10)
    assert.deepEqual(
        result.plan,
        (refineDreamMemories(fullGroupsInput()) as typeof result).plan
    )
})

it('ranks candidates using original vectors and stores symmetric union weights once', () => {
    const matrix = {
        entryCount: 4,
        dimension: 2,
        vectors: new Float32Array([2, 0, 1, 1, 0, 3, -1, 0])
    }
    const graph = buildDreamGraph(matrix, candidatesFor(4), () => {})
    assert.equal(graph.weights.length, 4)
    assert.deepEqual([...graph.topNeighbors.slice(0, 3)], [1, 2, 3])
    for (let u = 0; u < 4; u++) {
        for (let edge = graph.offsets[u]; edge < graph.offsets[u + 1]; edge++) {
            const v = graph.neighbors[edge]
            const reverse =
                graph.neighbors
                    .subarray(graph.offsets[v], graph.offsets[v + 1])
                    .indexOf(u) + graph.offsets[v]
            assert.equal(graph.weights[edge], graph.weights[reverse])
            assert.ok(graph.weights[edge] >= 0 && graph.weights[edge] <= 1)
        }
    }
    assert.equal(graph.topWeights[0], Math.fround(Math.SQRT1_2))
})

it('propagates cancellation', () => {
    const input = fullGroupsInput()
    Atomics.store(new Int32Array(input.cancellation), 0, 1)
    assert.throws(() => refineDreamMemories(input), /已取消/u)
})

it('retains initial when every candidate edge has zero weight', () => {
    const result = refineDreamMemories({
        matrix: {
            entryCount: 2,
            dimension: 1,
            vectors: new Float32Array([1, -1])
        },
        initial: {
            labels: new Uint32Array([0, 0]),
            sizes: new Uint32Array([2]),
            clusterCount: 1
        },
        candidates: candidatesFor(2),
        cancellation: new SharedArrayBuffer(4)
    })
    assert.equal(result.outcome, 'use-initial')
    assert.equal(result.diagnostics.stopReason, 'empty-graph')
    assert.equal(result.diagnostics.graphEdgeCount, 0)
})

it('keeps a complete checkpoint when the edge budget ends before a whole row scan', () => {
    const input = fullGroupsInput()
    const graph = buildDreamGraph(input.matrix, input.candidates, () => {})
    const before = input.initial.labels.slice()
    const objective = calculateDreamGraphObjective(
        graph,
        input.initial,
        () => {}
    )
    const result = refineDreamPlan(graph, input.initial, objective, () => {}, 0)
    assert.equal(result.stopReason, 'edge-budget')
    assert.equal(result.finalObjective, objective)
    assert.deepEqual(result.plan.labels, before)
})

it('matches exhaustive objective changes for the first accepted move or swap', () => {
    // 六点小图可穷举锚点的所有合法操作，独立重算目标以核验交换互边项。
    for (let seed = 1; seed <= 24; seed++) {
        const n = 6
        const weights = Array.from({ length: n }, () => new Float32Array(n))
        let random = seed
        for (let u = 0; u < n; u++) {
            for (let v = u + 1; v < n; v++) {
                random = (Math.imul(random, 1664525) + 1013904223) >>> 0
                weights[u][v] = weights[v][u] = Math.fround(
                    random / 0x1_0000_0000
                )
            }
        }
        const original = new Uint32Array([0, 0, 1, 1, 2, 2])
        const objective = (labels: Uint32Array) => {
            let total = 0
            for (let u = 0; u < n; u++)
                for (let v = u + 1; v < n; v++) {
                    if (labels[u] === labels[v]) total += weights[u][v]
                }
            return total
        }
        let best = objective(original)
        for (const group of [1, 2]) {
            const moved = original.slice()
            moved[0] = group
            best = Math.max(best, objective(moved))
            for (let v = 2; v < n; v++) {
                if (original[v] !== group) continue
                const swapped = original.slice()
                swapped[0] = group
                swapped[v] = 0
                best = Math.max(best, objective(swapped))
            }
        }
        if (best === objective(original)) continue
        const graph: DreamSparseGraph = {
            offsets: Uint32Array.from({ length: n + 1 }, (_, i) => i * (n - 1)),
            neighbors: new Uint32Array(n * (n - 1)),
            weights: new Float32Array(n * (n - 1)),
            topNeighbors: new Uint32Array(n * (n - 1)),
            topWeights: new Float32Array(n * (n - 1)),
            q: n - 1
        }
        for (let u = 0; u < n; u++) {
            let edge = graph.offsets[u]
            for (let v = 0; v < n; v++) {
                if (u === v) continue
                graph.neighbors[edge] = graph.topNeighbors[edge] = v
                graph.weights[edge] = graph.topWeights[edge++] = weights[u][v]
            }
        }
        const plan: DreamPlanLabels = {
            labels: original.slice(),
            sizes: new Uint32Array([2, 2, 2]),
            clusterCount: 3
        }
        // 首个锚点及四个交换伙伴各扫描一次，随后通过边访问上限结束搜索。
        const result = refineDreamPlan(
            graph,
            plan,
            objective(original),
            () => {},
            (n - 1) * graph.q
        )
        assert.equal(result.acceptedMoves + result.acceptedSwaps, 1)
        assert.equal(objective(result.plan.labels), best)
        assert.equal(result.finalObjective, best)
        const counts = [0, 0, 0]
        result.plan.labels.forEach((label) => counts[label]++)
        assert.deepEqual([...result.plan.sizes], counts)
        assert.ok(counts.every((count) => count > 0 && count <= 30))
    }
})
