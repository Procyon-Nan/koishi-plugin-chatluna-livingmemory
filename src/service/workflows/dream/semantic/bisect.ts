import { dreamBatchSize, type DreamBisectInput } from './types'

export const bisectDreamMemories = (
    { matrix, cancellation, budgetMs }: DreamBisectInput,
    onProgress?: (completed: number, total: number) => void
) => {
    const startedAt = performance.now()
    const cancelled = new Int32Array(cancellation)
    const checkExecution = () => {
        if (Atomics.load(cancelled, 0) !== 0) {
            throw new Error('Dream 分组已取消。')
        }
        if (performance.now() - startedAt >= budgetMs) {
            throw new Error('Dream 容量二分达到计算期限。')
        }
    }
    checkExecution()
    const { entryCount, dimension, vectors } = matrix
    const clusterCount = Math.ceil(entryCount / dreamBatchSize)
    const labels = new Uint32Array(entryCount)
    const sizes = new Uint32Array(clusterCount)
    const inverseNorms = new Float64Array(entryCount)
    const permutation = Uint32Array.from({ length: entryCount }, (_, i) => i)
    const bestPartition = new Uint32Array(entryCount)
    const deltas = new Float64Array(entryCount)
    const centerLeft = new Float64Array(dimension)
    const centerRight = new Float64Array(dimension)
    const sumLeft = new Float64Array(dimension)
    const sumRight = new Float64Array(dimension)

    for (let row = 0; row < entryCount; row++) {
        if (row % 64 === 0) checkExecution()
        let squaredNorm = 0
        for (let d = 0; d < dimension; d++) {
            const value = vectors[row * dimension + d]
            squaredNorm += value * value
        }
        if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
            throw new Error(`Dream 向量须具有有限正范数：row=${row}`)
        }
        inverseNorms[row] = 1 / Math.sqrt(squaredNorm)
    }

    const copyDirection = (row: number, target: Float64Array) => {
        for (let d = 0; d < dimension; d++) {
            target[d] = vectors[row * dimension + d] * inverseNorms[row]
        }
    }
    const dot = (row: number, center: Float64Array) => {
        let value = 0
        for (let d = 0; d < dimension; d++) {
            value += vectors[row * dimension + d] * center[d]
        }
        return value * inverseNorms[row]
    }
    const farthest = (members: Uint32Array, center: Float64Array) => {
        let selected = members[0]
        let lowest = Infinity
        for (let i = 0; i < members.length; i++) {
            if (i % 64 === 0) checkExecution()
            const row = members[i]
            const score = dot(row, center)
            if (score < lowest || (score === lowest && row < selected)) {
                selected = row
                lowest = score
            }
        }
        return selected
    }

    let seed = 7
    let nextLabel = 0
    const stack =
        entryCount === 0
            ? []
            : [{ start: 0, end: entryCount, groups: clusterCount }]
    while (stack.length > 0) {
        checkExecution()
        const { start, end, groups } = stack.pop()!
        const members = permutation.subarray(start, end)
        if (groups === 1) {
            for (const row of members) labels[row] = nextLabel
            sizes[nextLabel++] = members.length
            onProgress?.(nextLabel, clusterCount)
            continue
        }
        const leftGroups = Math.floor(groups / 2)
        const rightGroups = groups - leftGroups
        const low = Math.max(
            leftGroups,
            members.length - dreamBatchSize * rightGroups
        )
        const high = Math.min(
            dreamBatchSize * leftGroups,
            members.length - rightGroups
        )
        const balancedCut = (members.length * leftGroups) / groups
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed = (seed ^ (seed << 5)) >>> 0
        copyDirection(members[seed % members.length], centerLeft)
        copyDirection(farthest(members, centerLeft), centerLeft)
        copyDirection(farthest(members, centerLeft), centerRight)

        let bestObjective = -Infinity
        let bestCut = low
        for (let iteration = 0; iteration < 3; iteration++) {
            for (let i = 0; i < members.length; i++) {
                if (i % 64 === 0) checkExecution()
                const row = members[i]
                deltas[row] = dot(row, centerRight) - dot(row, centerLeft)
            }
            let comparisons = 0
            members.sort((a, b) => {
                if (++comparisons % 4096 === 0) checkExecution()
                return deltas[a] - deltas[b] || a - b
            })
            let prefix = 0
            let lowestCost = Infinity
            let cut = low
            for (let count = 1; count <= high; count++) {
                prefix += deltas[members[count - 1]]
                if (count < low) continue
                if (
                    prefix < lowestCost ||
                    (prefix === lowestCost &&
                        Math.abs(count - balancedCut) <
                            Math.abs(cut - balancedCut))
                ) {
                    lowestCost = prefix
                    cut = count
                }
            }
            sumLeft.fill(0)
            sumRight.fill(0)
            for (let i = 0; i < members.length; i++) {
                if (i % 64 === 0) checkExecution()
                const row = members[i]
                const sum = i < cut ? sumLeft : sumRight
                for (let d = 0; d < dimension; d++) {
                    sum[d] += vectors[row * dimension + d] * inverseNorms[row]
                }
            }
            let leftNorm = 0
            let rightNorm = 0
            for (let d = 0; d < dimension; d++) {
                leftNorm += sumLeft[d] ** 2
                rightNorm += sumRight[d] ** 2
            }
            leftNorm = Math.sqrt(leftNorm)
            rightNorm = Math.sqrt(rightNorm)
            const objective = leftNorm + rightNorm
            if (objective > bestObjective) {
                bestObjective = objective
                bestCut = cut
                bestPartition.set(members, start)
            }
            for (let d = 0; d < dimension; d++) {
                if (leftNorm > Number.EPSILON * members.length) {
                    centerLeft[d] = sumLeft[d] / leftNorm
                }
                if (rightNorm > Number.EPSILON * members.length) {
                    centerRight[d] = sumRight[d] / rightNorm
                }
            }
        }
        members.set(bestPartition.subarray(start, end))
        const middle = start + bestCut
        stack.push({ start: middle, end, groups: rightGroups })
        stack.push({ start, end: middle, groups: leftGroups })
    }
    checkExecution()
    return {
        matrix,
        plan: { labels, sizes, clusterCount },
        elapsedMs: performance.now() - startedAt
    }
}
