import {
    dreamCandidateWidth,
    dreamNeighborCount,
    type DreamCandidates,
    type DreamPlanLabels,
    type DreamSparseGraph,
    type DreamVectorMatrix
} from './types'

export const buildDreamGraph = (
    matrix: DreamVectorMatrix,
    candidates: DreamCandidates,
    checkExecution: () => void
): DreamSparseGraph => {
    const { entryCount: n, dimension, vectors } = matrix
    const { q, counts, neighbors } = candidates
    if (
        counts.length !== n ||
        neighbors.length !== n * dreamCandidateWidth ||
        q !== Math.min(dreamNeighborCount, n - 1)
    )
        throw new Error('Dream 候选矩阵尺寸无效。')
    const inverseNorms = new Float64Array(n)
    for (let row = 0; row < n; row++) {
        checkExecution()
        let norm = 0
        for (let d = 0; d < dimension; d++) {
            if (d % 4096 === 0) checkExecution()
            norm += vectors[row * dimension + d] ** 2
        }
        inverseNorms[row] = 1 / Math.sqrt(norm)
    }
    const topNeighbors = new Uint32Array(n * q)
    const topWeights = new Float32Array(n * q)
    const scores = new Float64Array(dreamCandidateWidth)
    const rank = new Uint32Array(dreamCandidateWidth)
    const seen = new Uint32Array(n)
    // 数值工作集上限约束 N，两个行号可编码为精确整数键 a*N+b。
    const keys = new Float64Array(n * q)
    for (let row = 0; row < n; row++) {
        checkExecution()
        const count = counts[row]
        if (count < q || count > dreamCandidateWidth)
            throw new Error('Dream 候选行覆盖不足。')
        const start = row * dreamCandidateWidth
        for (let i = 0; i < count; i++) {
            const neighbor = neighbors[start + i]
            if (
                neighbor >= n ||
                neighbor === row ||
                seen[neighbor] === row + 1
            ) {
                throw new Error('Dream 候选行包含无效或重复行号。')
            }
            seen[neighbor] = row + 1
            const a = Math.min(row, neighbor)
            const b = Math.max(row, neighbor)
            let dot = 0
            for (let d = 0; d < dimension; d++) {
                if (d % 4096 === 0) checkExecution()
                dot += vectors[a * dimension + d] * vectors[b * dimension + d]
            }
            scores[i] = Math.max(
                -1,
                Math.min(1, dot * inverseNorms[a] * inverseNorms[b])
            )
            rank[i] = i
        }
        rank.subarray(0, count).sort(
            (a, b) =>
                scores[b] - scores[a] ||
                neighbors[start + a] - neighbors[start + b]
        )
        for (let i = 0; i < q; i++) {
            const neighbor = neighbors[start + rank[i]]
            const slot = row * q + i
            topNeighbors[slot] = neighbor
            topWeights[slot] = Math.max(0, scores[rank[i]])
            keys[slot] = Math.min(row, neighbor) * n + Math.max(row, neighbor)
        }
    }
    const order = Uint32Array.from({ length: keys.length }, (_, i) => i)
    let comparisons = 0
    order.sort((a, b) => {
        if (++comparisons % 4096 === 0) checkExecution()
        return keys[a] - keys[b] || a - b
    })
    const offsets = new Uint32Array(n + 1)
    let previous = -1
    for (let i = 0; i < order.length; i++) {
        if (i % 4096 === 0) checkExecution()
        const slot = order[i]
        const key = keys[slot]
        if (topWeights[slot] === 0 || key === previous) continue
        previous = key
        offsets[Math.floor(key / n) + 1]++
        offsets[(key % n) + 1]++
    }
    for (let row = 0; row < n; row++) offsets[row + 1] += offsets[row]
    const graphNeighbors = new Uint32Array(offsets[n])
    const weights = new Float32Array(offsets[n])
    const cursor = offsets.slice(0, n)
    previous = -1
    for (let i = 0; i < order.length; i++) {
        if (i % 4096 === 0) checkExecution()
        const slot = order[i]
        const key = keys[slot]
        if (topWeights[slot] === 0 || key === previous) continue
        previous = key
        const a = Math.floor(key / n)
        const b = key % n
        const left = cursor[a]++
        const right = cursor[b]++
        graphNeighbors[left] = b
        graphNeighbors[right] = a
        weights[left] = weights[right] = topWeights[slot]
    }
    checkExecution()
    return {
        offsets,
        neighbors: graphNeighbors,
        weights,
        topNeighbors,
        topWeights,
        q
    }
}

export const calculateDreamGraphObjective = (
    graph: DreamSparseGraph,
    plan: DreamPlanLabels,
    checkExecution: () => void
) => {
    let objective = 0
    for (let row = 0; row < plan.labels.length; row++) {
        for (
            let edge = graph.offsets[row];
            edge < graph.offsets[row + 1];
            edge++
        ) {
            if (edge % 4096 === 0) checkExecution()
            const neighbor = graph.neighbors[edge]
            if (row < neighbor && plan.labels[row] === plan.labels[neighbor])
                objective += graph.weights[edge]
        }
    }
    checkExecution()
    return objective
}
