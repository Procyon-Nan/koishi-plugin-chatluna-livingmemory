import { buildDreamGraph, calculateDreamGraphObjective } from './graph'
import {
    dreamBatchSize,
    type DreamPlanLabels,
    type DreamRefineDiagnostics,
    type DreamRefineInput,
    type DreamRefineResult,
    type DreamSparseGraph
} from './types'

export const refineDreamPlan = (
    graph: DreamSparseGraph,
    plan: DreamPlanLabels,
    initialObjective: number,
    canContinue: () => boolean,
    checkCancellation: () => void,
    maxEdgeVisits = 100 * plan.labels.length * graph.q
) => {
    const { labels, sizes, clusterCount } = plan
    const n = labels.length
    const members = new Uint32Array(dreamBatchSize * clusterCount)
    const slotOf = new Uint32Array(n)
    const filled = new Uint32Array(clusterCount)
    const used = new Uint8Array(n)
    for (let row = 0; row < n; row++) {
        const group = labels[row]
        slotOf[row] = filled[group]++
        members[group * dreamBatchSize + slotOf[row]] = row
    }
    const anchorSums = new Float64Array(clusterCount)
    const partnerSums = new Float64Array(clusterCount)
    const anchorTouched: number[] = []
    const partnerTouched: number[] = []
    const partnerHints = new Float64Array(dreamBatchSize)
    const partnerOrder = new Uint32Array(dreamBatchSize)
    let edgeVisits = 0
    let hintEdgeVisits = 0
    let acceptedMoves = 0
    let acceptedSwaps = 0
    let bestObjective = initialObjective
    let expectedObjective = initialObjective
    const bestLabels = labels.slice()
    const bestSizes = sizes.slice()
    let stopReason = 'refine-passes'

    const scanRow = (
        row: number,
        sums: Float64Array,
        touched: number[],
        anchor = -1
    ) => {
        const degree = graph.offsets[row + 1] - graph.offsets[row]
        if (edgeVisits + degree > maxEdgeVisits) {
            stopReason = 'edge-budget'
            return undefined
        }
        edgeVisits += degree
        for (const group of touched) sums[group] = 0
        touched.length = 0
        let mutualWeight = 0
        for (
            let edge = graph.offsets[row];
            edge < graph.offsets[row + 1];
            edge++
        ) {
            if (edge % 1024 === 0 && !canContinue()) {
                stopReason = 'refine-budget'
                return undefined
            }
            const neighbor = graph.neighbors[edge]
            const weight = graph.weights[edge]
            const group = labels[neighbor]
            if (weight > 0 && sums[group] === 0) touched.push(group)
            sums[group] += weight
            if (neighbor === anchor) mutualWeight = weight
        }
        return mutualWeight
    }
    for (let pass = 0; pass < 3; pass++) {
        used.fill(0)
        let accepted = 0
        let stopped = false
        for (let u = 0; u < n; u++) {
            if (!canContinue()) {
                stopReason = 'refine-budget'
                stopped = true
                break
            }
            if (used[u]) continue
            if (scanRow(u, anchorSums, anchorTouched) === undefined) {
                stopped = true
                break
            }
            const a = labels[u]
            const groups = anchorTouched
                .filter((group) => group !== a)
                .sort(
                    (left, right) =>
                        anchorSums[right] - anchorSums[left] || left - right
                )
                .slice(0, 3)
            let bestGain = 0
            let bestGroup = -1
            let bestPartner = -1
            const consider = (
                gain: number,
                group: number,
                partner: number,
                partnerScale = 0
            ) => {
                const tolerance =
                    32 *
                    Number.EPSILON *
                    Math.max(
                        1,
                        anchorSums[a],
                        anchorSums[group],
                        partnerScale,
                        Math.abs(gain)
                    )
                if (gain <= tolerance) return
                if (
                    gain > bestGain ||
                    (gain === bestGain &&
                        (group < bestGroup ||
                            (group === bestGroup && partner < bestPartner)))
                ) {
                    bestGain = gain
                    bestGroup = group
                    bestPartner = partner
                }
            }
            for (const b of groups) {
                const anchorGain = anchorSums[b] - anchorSums[a]
                if (sizes[a] > 1 && sizes[b] < dreamBatchSize)
                    consider(anchorGain, b, -1)
                let partnerCount = 0
                for (let slot = 0; slot < sizes[b]; slot++) {
                    const v = members[b * dreamBatchSize + slot]
                    if (used[v]) continue
                    if (!canContinue()) {
                        stopReason = 'refine-budget'
                        stopped = true
                        break
                    }
                    hintEdgeVisits += graph.q
                    let hint = 0
                    for (let i = v * graph.q; i < (v + 1) * graph.q; i++) {
                        const group = labels[graph.topNeighbors[i]]
                        if (group === a) hint += graph.topWeights[i]
                        if (group === b) hint -= graph.topWeights[i]
                    }
                    partnerHints[slot] = hint
                    partnerOrder[partnerCount++] = slot
                }
                if (stopped) break
                partnerOrder
                    .subarray(0, partnerCount)
                    .sort(
                        (left, right) =>
                            partnerHints[right] - partnerHints[left] ||
                            members[b * dreamBatchSize + left] -
                                members[b * dreamBatchSize + right]
                    )
                for (let i = 0; i < Math.min(4, partnerCount); i++) {
                    const v = members[b * dreamBatchSize + partnerOrder[i]]
                    const mutualWeight = scanRow(
                        v,
                        partnerSums,
                        partnerTouched,
                        u
                    )
                    if (mutualWeight === undefined) {
                        stopped = true
                        break
                    }
                    consider(
                        anchorGain +
                            partnerSums[a] -
                            partnerSums[b] -
                            2 * mutualWeight,
                        b,
                        v,
                        partnerSums[a] + partnerSums[b] + 2 * mutualWeight
                    )
                }
                if (stopped) break
            }
            if (stopped) break
            if (!canContinue()) {
                stopReason = 'refine-budget'
                stopped = true
                break
            }
            if (bestGroup < 0) continue
            const b = bestGroup
            const slot = slotOf[u]
            if (bestPartner < 0) {
                sizes[a]--
                const tail = members[a * dreamBatchSize + sizes[a]]
                members[a * dreamBatchSize + slot] = tail
                slotOf[tail] = slot
                slotOf[u] = sizes[b]
                members[b * dreamBatchSize + slotOf[u]] = u
                sizes[b]++
                acceptedMoves++
            } else {
                const v = bestPartner
                const otherSlot = slotOf[v]
                members[a * dreamBatchSize + slot] = v
                members[b * dreamBatchSize + otherSlot] = u
                slotOf[v] = slot
                slotOf[u] = otherSlot
                labels[v] = a
                used[v] = 1
                acceptedSwaps++
            }
            labels[u] = b
            used[u] = 1
            expectedObjective += bestGain
            accepted++
        }
        // 结束复核使用预留时间，搜索预算只计量收益计算访问。
        const objective = calculateDreamGraphObjective(
            graph,
            plan,
            checkCancellation
        )
        const tolerance =
            64 *
            Number.EPSILON *
            Math.max(1, objective) *
            Math.max(1, graph.weights.length)
        if (
            !Number.isFinite(objective) ||
            objective + tolerance < bestObjective ||
            Math.abs(objective - expectedObjective) > tolerance
        ) {
            throw new Error('Dream 图目标与已提交收益不符。')
        }
        if (objective >= bestObjective) {
            bestObjective = objective
            bestLabels.set(labels)
            bestSizes.set(sizes)
        }
        expectedObjective = objective
        if (stopped) break
        if (accepted === 0) {
            stopReason = 'local-optimum'
            break
        }
    }
    checkCancellation()
    return {
        plan: { labels: bestLabels, sizes: bestSizes, clusterCount },
        initialObjective,
        finalObjective: bestObjective,
        acceptedMoves,
        acceptedSwaps,
        edgeVisits,
        hintEdgeVisits,
        stopReason
    }
}

export const refineDreamMemories = (
    input: DreamRefineInput
): DreamRefineResult => {
    const startedAt = performance.now()
    const cancelled = new Int32Array(input.cancellation)
    const checkCancellation = () => {
        if (Atomics.load(cancelled, 0) !== 0)
            throw new Error('Dream 分组已取消。')
    }
    const deadline =
        startedAt + input.budgetMs - Math.min(1000, input.budgetMs * 0.1)
    const canContinue = () => {
        checkCancellation()
        return performance.now() < deadline
    }
    const budgetReached = Symbol('refine-budget')
    const checkGraphExecution = () => {
        if (!canContinue()) throw budgetReached
    }
    const diagnostics: DreamRefineDiagnostics = {
        graphComplete: false,
        graphEdgeCount: 0,
        acceptedMoves: 0,
        acceptedSwaps: 0,
        edgeVisits: 0,
        hintEdgeVisits: 0,
        refineMs: 0,
        stopReason: 'budget-before-graph'
    }
    let graph: DreamSparseGraph
    let initialObjective: number
    try {
        checkGraphExecution()
        graph = buildDreamGraph(
            input.matrix,
            input.candidates,
            checkGraphExecution
        )
        initialObjective = calculateDreamGraphObjective(
            graph,
            input.initial,
            checkGraphExecution
        )
    } catch (error) {
        if (error !== budgetReached) throw error
        return {
            outcome: 'use-initial',
            diagnostics: {
                ...diagnostics,
                refineMs: performance.now() - startedAt
            }
        }
    }
    diagnostics.graphComplete = true
    diagnostics.graphEdgeCount = graph.weights.length / 2
    diagnostics.initialObjective = initialObjective
    diagnostics.finalObjective = initialObjective
    if (graph.weights.length === 0) {
        return {
            outcome: 'use-initial',
            diagnostics: {
                ...diagnostics,
                stopReason: 'empty-graph',
                refineMs: performance.now() - startedAt
            }
        }
    }
    const { plan, ...result } = refineDreamPlan(
        graph,
        input.initial,
        initialObjective,
        canContinue,
        checkCancellation
    )
    return {
        outcome: 'refined',
        plan,
        diagnostics: {
            ...diagnostics,
            ...result,
            refineMs: performance.now() - startedAt
        }
    }
}
