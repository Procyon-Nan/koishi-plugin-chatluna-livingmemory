import type { MemoryEntryRecord } from '../../../../contracts/memory'
import {
    calculatePartitionQuality,
    compareEntryIds,
    similarityAt
} from './similarity'

export interface PartitionState {
    batches: number[][]
    batchOf: Int32Array
    gains: Uint16Array
}

interface PartitionChoice {
    entryIndex: number
    batchIndex: number
}

const assignEntry = (
    state: PartitionState,
    similarities: Uint8Array,
    entryCount: number,
    entryIndex: number,
    batchIndex: number
) => {
    const batchCount = state.batches.length
    state.batchOf[entryIndex] = batchIndex
    state.batches[batchIndex].push(entryIndex)
    for (let other = 0; other < entryCount; other++) {
        state.gains[other * batchCount + batchIndex] += similarityAt(
            similarities,
            entryCount,
            other,
            entryIndex
        )
    }
}

const selectDispersedSeed = (
    entries: readonly MemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    seeds: readonly number[],
    batchOf: Int32Array
) => {
    let best = -1
    let bestDenominator = 1
    for (let candidate = 0; candidate < entries.length; candidate++) {
        if (batchOf[candidate] !== -1) {
            continue
        }

        let denominator = 1
        for (const seed of seeds) {
            denominator += similarityAt(
                similarities,
                entries.length,
                candidate,
                seed
            )
        }
        if (best === -1) {
            best = candidate
            bestDenominator = denominator
            continue
        }

        const candidateScore = degrees[candidate] * bestDenominator
        const bestScore = degrees[best] * denominator
        if (
            candidateScore > bestScore ||
            (candidateScore === bestScore &&
                (degrees[candidate] > degrees[best] ||
                    (degrees[candidate] === degrees[best] &&
                        compareEntryIds(
                            entries[candidate].id,
                            entries[best].id
                        ) < 0)))
        ) {
            best = candidate
            bestDenominator = denominator
        }
    }
    return best
}

const selectPreferredChoices = (
    entries: readonly MemoryEntryRecord[],
    degrees: Uint32Array,
    state: PartitionState,
    openBatches: readonly number[]
): PartitionChoice[] => {
    const entryCount = entries.length
    const batchCount = state.batches.length
    const preferredBatch = new Int32Array(entryCount)
    preferredBatch.fill(-1)

    for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
        if (state.batchOf[entryIndex] !== -1) {
            continue
        }

        let preferred = openBatches[0]
        for (let offset = 1; offset < openBatches.length; offset++) {
            const candidateBatch = openBatches[offset]
            if (
                state.gains[entryIndex * batchCount + candidateBatch] >
                state.gains[entryIndex * batchCount + preferred]
            ) {
                preferred = candidateBatch
            }
        }
        preferredBatch[entryIndex] = preferred
    }

    const selected = new Set<number>()
    const choices: PartitionChoice[] = []
    for (const batchIndex of openBatches) {
        let best = -1
        let bestMargin = Number.NEGATIVE_INFINITY
        for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
            if (
                state.batchOf[entryIndex] !== -1 ||
                selected.has(entryIndex) ||
                preferredBatch[entryIndex] !== batchIndex
            ) {
                continue
            }

            const gain = state.gains[entryIndex * batchCount + batchIndex]
            let alternativeGain = 0
            for (const otherBatch of openBatches) {
                if (otherBatch !== batchIndex) {
                    alternativeGain = Math.max(
                        alternativeGain,
                        state.gains[entryIndex * batchCount + otherBatch]
                    )
                }
            }
            const margin = gain - alternativeGain
            const bestGain =
                best === -1 ? -1 : state.gains[best * batchCount + batchIndex]
            if (
                best === -1 ||
                gain > bestGain ||
                (gain === bestGain &&
                    (margin > bestMargin ||
                        (margin === bestMargin &&
                            (degrees[entryIndex] > degrees[best] ||
                                (degrees[entryIndex] === degrees[best] &&
                                    compareEntryIds(
                                        entries[entryIndex].id,
                                        entries[best].id
                                    ) < 0)))))
            ) {
                best = entryIndex
                bestMargin = margin
            }
        }

        // 某个批次没有首选条目时，选择相对损失最小的未分配条目以维持同步生长。
        if (best === -1) {
            let bestLoss = Number.NEGATIVE_INFINITY
            for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
                if (
                    state.batchOf[entryIndex] !== -1 ||
                    selected.has(entryIndex)
                ) {
                    continue
                }

                let maximumGain = 0
                for (const otherBatch of openBatches) {
                    maximumGain = Math.max(
                        maximumGain,
                        state.gains[entryIndex * batchCount + otherBatch]
                    )
                }
                const loss =
                    state.gains[entryIndex * batchCount + batchIndex] -
                    maximumGain
                if (
                    best === -1 ||
                    loss > bestLoss ||
                    (loss === bestLoss &&
                        (degrees[entryIndex] > degrees[best] ||
                            (degrees[entryIndex] === degrees[best] &&
                                compareEntryIds(
                                    entries[entryIndex].id,
                                    entries[best].id
                                ) < 0)))
                ) {
                    best = entryIndex
                    bestLoss = loss
                }
            }
        }

        if (best !== -1) {
            selected.add(best)
            choices.push({ entryIndex: best, batchIndex })
        }
    }
    return choices
}

export const createInitialPartition = (
    entries: readonly MemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    targetSizes: readonly number[],
    attempt: number
): PartitionState => {
    const entryCount = entries.length
    const batchCount = targetSizes.length
    const state: PartitionState = {
        batches: Array.from({ length: batchCount }, () => []),
        batchOf: new Int32Array(entryCount),
        gains: new Uint16Array(entryCount * batchCount)
    }
    state.batchOf.fill(-1)
    const traversal = Array.from(
        { length: batchCount },
        (_, offset) => (offset + attempt) % batchCount
    )
    const degreeRanking = Array.from(
        { length: entryCount },
        (_, index) => index
    ).sort(
        (left, right) =>
            degrees[right] - degrees[left] ||
            compareEntryIds(entries[left].id, entries[right].id)
    )

    // 各起点先放置彼此尽量分散的种子，减少关键词岛被过早合并。
    const seeds = [degreeRanking[Math.min(attempt, entryCount - 1)]]
    assignEntry(state, similarities, entryCount, seeds[0], traversal[0])
    for (let offset = 1; offset < batchCount; offset++) {
        const seed = selectDispersedSeed(
            entries,
            similarities,
            degrees,
            seeds,
            state.batchOf
        )
        seeds.push(seed)
        assignEntry(state, similarities, entryCount, seed, traversal[offset])
    }

    // 每轮最多为每个未满批次分配一个条目，避免顺序偏置破坏容量均衡。
    let assignedCount = seeds.length
    while (assignedCount < entryCount) {
        const openBatches = traversal.filter(
            (batchIndex) =>
                state.batches[batchIndex].length < targetSizes[batchIndex]
        )
        const choices = selectPreferredChoices(
            entries,
            degrees,
            state,
            openBatches
        )
        if (choices.length === 0) {
            throw new Error('dream partitioning failed: no assignable entries')
        }
        for (const choice of choices) {
            assignEntry(
                state,
                similarities,
                entryCount,
                choice.entryIndex,
                choice.batchIndex
            )
            assignedCount++
        }
    }
    return state
}

export const selectBestInitialPartition = (
    entries: readonly MemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    targetSizes: readonly number[],
    attemptCount: number
) => {
    const firstState = createInitialPartition(
        entries,
        similarities,
        degrees,
        targetSizes,
        0
    )
    let bestState = firstState
    let bestQuality = calculatePartitionQuality(
        firstState.batches,
        similarities,
        entries.length
    )

    for (let attempt = 1; attempt < attemptCount; attempt++) {
        const state = createInitialPartition(
            entries,
            similarities,
            degrees,
            targetSizes,
            attempt
        )
        const quality = calculatePartitionQuality(
            state.batches,
            similarities,
            entries.length
        )
        if (quality > bestQuality) {
            bestState = state
            bestQuality = quality
        }
    }
    return { state: bestState, quality: bestQuality }
}
