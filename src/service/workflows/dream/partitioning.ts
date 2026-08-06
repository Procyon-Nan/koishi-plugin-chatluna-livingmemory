import type { MemoryEntryRecord } from '../../../contracts/memory'
import { normalizeMemoryKeywords } from '../../memory/entry_fields'

export const DREAM_PARTITION_TARGET_SIZE = 300
export const DREAM_PARTITION_MAX_SIZE = 350

const PARTITION_ATTEMPTS = 3
const LOCAL_OPTIMIZATION_ROUNDS = 4

interface PartitionState {
    batches: number[][]
    batchOf: Int32Array
    gains: Uint16Array
}

interface PartitionCandidate {
    batches: number[][]
    quality: number
}

const compareIds = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0

export const selectDreamPartitionCount = (entryCount: number) => {
    if (entryCount <= 0) {
        return 0
    }

    const minimum = Math.max(
        1,
        Math.ceil(entryCount / DREAM_PARTITION_MAX_SIZE)
    )
    const candidates = [
        minimum,
        Math.floor(entryCount / DREAM_PARTITION_TARGET_SIZE),
        Math.ceil(entryCount / DREAM_PARTITION_TARGET_SIZE)
    ].filter(
        (value, index, values) =>
            value >= minimum &&
            value <= entryCount &&
            values.indexOf(value) === index
    )

    return candidates.sort((left, right) => {
        const leftDistance = Math.abs(
            entryCount / left - DREAM_PARTITION_TARGET_SIZE
        )
        const rightDistance = Math.abs(
            entryCount / right - DREAM_PARTITION_TARGET_SIZE
        )
        return leftDistance - rightDistance || left - right
    })[0]
}

const buildTargetSizes = (entryCount: number, batchCount: number) => {
    const baseSize = Math.floor(entryCount / batchCount)
    const largerBatchCount = entryCount % batchCount
    return Array.from(
        { length: batchCount },
        (_, index) => baseSize + (index < largerBatchCount ? 1 : 0)
    )
}

const buildSimilarityData = (entries: readonly MemoryEntryRecord[]) => {
    const entryCount = entries.length
    const similarities = new Uint8Array(entryCount * entryCount)
    const degrees = new Uint32Array(entryCount)
    const postingLists = new Map<string, number[]>()

    entries.forEach((entry, index) => {
        for (const keyword of normalizeMemoryKeywords(entry.keywords)) {
            const postingList = postingLists.get(keyword)
            if (postingList == null) {
                postingLists.set(keyword, [index])
            } else {
                postingList.push(index)
            }
        }
    })

    for (const postingList of postingLists.values()) {
        for (let leftIndex = 0; leftIndex < postingList.length; leftIndex++) {
            const left = postingList[leftIndex]
            for (
                let rightIndex = leftIndex + 1;
                rightIndex < postingList.length;
                rightIndex++
            ) {
                const right = postingList[rightIndex]
                similarities[left * entryCount + right]++
                similarities[right * entryCount + left]++
                degrees[left]++
                degrees[right]++
            }
        }
    }

    return { degrees, similarities }
}

const similarityAt = (
    similarities: Uint8Array,
    entryCount: number,
    left: number,
    right: number
) => similarities[left * entryCount + right]

const createInitialPartition = (
    entries: readonly MemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    targetSizes: readonly number[],
    attempt: number
): PartitionState => {
    const entryCount = entries.length
    const batchCount = targetSizes.length
    const batches = Array.from({ length: batchCount }, () => [] as number[])
    const batchOf = new Int32Array(entryCount)
    batchOf.fill(-1)
    const gains = new Uint16Array(entryCount * batchCount)
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
            compareIds(entries[left].id, entries[right].id)
    )

    const assign = (entryIndex: number, batchIndex: number) => {
        batchOf[entryIndex] = batchIndex
        batches[batchIndex].push(entryIndex)
        for (let other = 0; other < entryCount; other++) {
            gains[other * batchCount + batchIndex] += similarityAt(
                similarities,
                entryCount,
                other,
                entryIndex
            )
        }
    }

    const seeds: number[] = []
    const firstSeed = degreeRanking[Math.min(attempt, entryCount - 1)]
    seeds.push(firstSeed)
    assign(firstSeed, traversal[0])

    for (let offset = 1; offset < batchCount; offset++) {
        let best = -1
        let bestDenominator = 1
        for (let candidate = 0; candidate < entryCount; candidate++) {
            if (batchOf[candidate] !== -1) {
                continue
            }

            let denominator = 1
            for (const seed of seeds) {
                denominator += similarityAt(
                    similarities,
                    entryCount,
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
                            compareIds(
                                entries[candidate].id,
                                entries[best].id
                            ) < 0)))
            ) {
                best = candidate
                bestDenominator = denominator
            }
        }

        seeds.push(best)
        assign(best, traversal[offset])
    }

    let assignedCount = seeds.length
    while (assignedCount < entryCount) {
        const openBatches = traversal.filter(
            (batchIndex) => batches[batchIndex].length < targetSizes[batchIndex]
        )
        const preferredBatch = new Int32Array(entryCount)
        preferredBatch.fill(-1)

        for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
            if (batchOf[entryIndex] !== -1) {
                continue
            }

            let preferred = openBatches[0]
            for (let offset = 1; offset < openBatches.length; offset++) {
                const candidateBatch = openBatches[offset]
                if (
                    gains[entryIndex * batchCount + candidateBatch] >
                    gains[entryIndex * batchCount + preferred]
                ) {
                    preferred = candidateBatch
                }
            }
            preferredBatch[entryIndex] = preferred
        }

        const selected = new Set<number>()
        const choices: { entryIndex: number; batchIndex: number }[] = []
        for (const batchIndex of openBatches) {
            let best = -1
            let bestMargin = Number.NEGATIVE_INFINITY
            for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
                if (
                    batchOf[entryIndex] !== -1 ||
                    selected.has(entryIndex) ||
                    preferredBatch[entryIndex] !== batchIndex
                ) {
                    continue
                }

                const gain = gains[entryIndex * batchCount + batchIndex]
                let alternativeGain = 0
                for (const otherBatch of openBatches) {
                    if (otherBatch !== batchIndex) {
                        alternativeGain = Math.max(
                            alternativeGain,
                            gains[entryIndex * batchCount + otherBatch]
                        )
                    }
                }
                const margin = gain - alternativeGain
                const bestGain =
                    best === -1 ? -1 : gains[best * batchCount + batchIndex]
                if (
                    best === -1 ||
                    gain > bestGain ||
                    (gain === bestGain &&
                        (margin > bestMargin ||
                            (margin === bestMargin &&
                                (degrees[entryIndex] > degrees[best] ||
                                    (degrees[entryIndex] === degrees[best] &&
                                        compareIds(
                                            entries[entryIndex].id,
                                            entries[best].id
                                        ) < 0)))))
                ) {
                    best = entryIndex
                    bestMargin = margin
                }
            }

            if (best === -1) {
                let bestLoss = Number.NEGATIVE_INFINITY
                for (
                    let entryIndex = 0;
                    entryIndex < entryCount;
                    entryIndex++
                ) {
                    if (
                        batchOf[entryIndex] !== -1 ||
                        selected.has(entryIndex)
                    ) {
                        continue
                    }

                    let maximumGain = 0
                    for (const otherBatch of openBatches) {
                        maximumGain = Math.max(
                            maximumGain,
                            gains[entryIndex * batchCount + otherBatch]
                        )
                    }
                    const loss =
                        gains[entryIndex * batchCount + batchIndex] -
                        maximumGain
                    if (
                        best === -1 ||
                        loss > bestLoss ||
                        (loss === bestLoss &&
                            (degrees[entryIndex] > degrees[best] ||
                                (degrees[entryIndex] === degrees[best] &&
                                    compareIds(
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

        if (choices.length === 0) {
            throw new Error('dream partitioning failed: no assignable entries')
        }
        for (const choice of choices) {
            assign(choice.entryIndex, choice.batchIndex)
            assignedCount++
        }
    }

    return { batches, batchOf, gains }
}

const calculatePartitionQuality = (
    batches: readonly number[][],
    similarities: Uint8Array,
    entryCount: number
) => {
    let quality = 0
    for (const batch of batches) {
        for (let leftIndex = 0; leftIndex < batch.length; leftIndex++) {
            for (
                let rightIndex = leftIndex + 1;
                rightIndex < batch.length;
                rightIndex++
            ) {
                quality += similarityAt(
                    similarities,
                    entryCount,
                    batch[leftIndex],
                    batch[rightIndex]
                )
            }
        }
    }
    return quality
}

const updateGainsAfterMove = (
    state: PartitionState,
    similarities: Uint8Array,
    entryCount: number,
    entryIndex: number,
    sourceBatch: number,
    targetBatch: number
) => {
    const batchCount = state.batches.length
    for (let other = 0; other < entryCount; other++) {
        const similarity = similarityAt(
            similarities,
            entryCount,
            other,
            entryIndex
        )
        state.gains[other * batchCount + sourceBatch] -= similarity
        state.gains[other * batchCount + targetBatch] += similarity
    }
}

const optimizePartition = (
    entries: readonly MemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    targetSizes: readonly number[],
    state: PartitionState
) => {
    const entryCount = entries.length
    const batchCount = state.batches.length
    const smallerSize = Math.floor(entryCount / batchCount)
    const largerSize = smallerSize + 1

    for (let round = 0; round < LOCAL_OPTIMIZATION_ROUNDS; round++) {
        let changed = false
        const usedEntries = new Set<number>()
        const moveCandidates: {
            entryIndex: number
            sourceBatch: number
            targetBatch: number
            delta: number
        }[] = []

        if (targetSizes.some((size) => size === largerSize)) {
            for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
                const sourceBatch = state.batchOf[entryIndex]
                if (state.batches[sourceBatch].length !== largerSize) {
                    continue
                }
                for (
                    let targetBatch = 0;
                    targetBatch < batchCount;
                    targetBatch++
                ) {
                    if (state.batches[targetBatch].length !== smallerSize) {
                        continue
                    }
                    const delta =
                        state.gains[entryIndex * batchCount + targetBatch] -
                        state.gains[entryIndex * batchCount + sourceBatch]
                    if (delta > 0) {
                        moveCandidates.push({
                            entryIndex,
                            sourceBatch,
                            targetBatch,
                            delta
                        })
                    }
                }
            }
        }

        moveCandidates.sort(
            (left, right) =>
                right.delta - left.delta ||
                compareIds(
                    entries[left.entryIndex].id,
                    entries[right.entryIndex].id
                ) ||
                left.sourceBatch - right.sourceBatch ||
                left.targetBatch - right.targetBatch
        )
        for (const candidate of moveCandidates) {
            if (
                usedEntries.has(candidate.entryIndex) ||
                state.batchOf[candidate.entryIndex] !== candidate.sourceBatch ||
                state.batches[candidate.sourceBatch].length !== largerSize ||
                state.batches[candidate.targetBatch].length !== smallerSize
            ) {
                continue
            }
            const delta =
                state.gains[
                    candidate.entryIndex * batchCount + candidate.targetBatch
                ] -
                state.gains[
                    candidate.entryIndex * batchCount + candidate.sourceBatch
                ]
            if (delta <= 0) {
                continue
            }

            state.batches[candidate.sourceBatch] = state.batches[
                candidate.sourceBatch
            ].filter((index) => index !== candidate.entryIndex)
            state.batches[candidate.targetBatch].push(candidate.entryIndex)
            state.batchOf[candidate.entryIndex] = candidate.targetBatch
            updateGainsAfterMove(
                state,
                similarities,
                entryCount,
                candidate.entryIndex,
                candidate.sourceBatch,
                candidate.targetBatch
            )
            usedEntries.add(candidate.entryIndex)
            changed = true
        }

        const candidateLimit = Math.max(
            8,
            Math.min(32, Math.ceil(Math.sqrt(entryCount / batchCount)))
        )
        const swapCandidates: {
            left: number
            right: number
            leftBatch: number
            rightBatch: number
            delta: number
        }[] = []
        for (let leftBatch = 0; leftBatch < batchCount; leftBatch++) {
            for (
                let rightBatch = leftBatch + 1;
                rightBatch < batchCount;
                rightBatch++
            ) {
                const leftCandidates = [...state.batches[leftBatch]]
                    .sort((left, right) => {
                        const leftScore =
                            state.gains[left * batchCount + rightBatch] -
                            state.gains[left * batchCount + leftBatch]
                        const rightScore =
                            state.gains[right * batchCount + rightBatch] -
                            state.gains[right * batchCount + leftBatch]
                        return (
                            rightScore - leftScore ||
                            degrees[right] - degrees[left] ||
                            compareIds(entries[left].id, entries[right].id)
                        )
                    })
                    .slice(0, candidateLimit)
                const rightCandidates = [...state.batches[rightBatch]]
                    .sort((left, right) => {
                        const leftScore =
                            state.gains[left * batchCount + leftBatch] -
                            state.gains[left * batchCount + rightBatch]
                        const rightScore =
                            state.gains[right * batchCount + leftBatch] -
                            state.gains[right * batchCount + rightBatch]
                        return (
                            rightScore - leftScore ||
                            degrees[right] - degrees[left] ||
                            compareIds(entries[left].id, entries[right].id)
                        )
                    })
                    .slice(0, candidateLimit)

                for (const left of leftCandidates) {
                    for (const right of rightCandidates) {
                        const delta =
                            state.gains[left * batchCount + rightBatch] +
                            state.gains[right * batchCount + leftBatch] -
                            state.gains[left * batchCount + leftBatch] -
                            state.gains[right * batchCount + rightBatch] -
                            2 *
                                similarityAt(
                                    similarities,
                                    entryCount,
                                    left,
                                    right
                                )
                        if (delta > 0) {
                            swapCandidates.push({
                                left,
                                right,
                                leftBatch,
                                rightBatch,
                                delta
                            })
                        }
                    }
                }
            }
        }

        swapCandidates.sort(
            (left, right) =>
                right.delta - left.delta ||
                compareIds(entries[left.left].id, entries[right.left].id) ||
                compareIds(entries[left.right].id, entries[right.right].id)
        )
        for (const candidate of swapCandidates) {
            if (
                usedEntries.has(candidate.left) ||
                usedEntries.has(candidate.right) ||
                state.batchOf[candidate.left] !== candidate.leftBatch ||
                state.batchOf[candidate.right] !== candidate.rightBatch
            ) {
                continue
            }
            const delta =
                state.gains[
                    candidate.left * batchCount + candidate.rightBatch
                ] +
                state.gains[
                    candidate.right * batchCount + candidate.leftBatch
                ] -
                state.gains[candidate.left * batchCount + candidate.leftBatch] -
                state.gains[
                    candidate.right * batchCount + candidate.rightBatch
                ] -
                2 *
                    similarityAt(
                        similarities,
                        entryCount,
                        candidate.left,
                        candidate.right
                    )
            if (delta <= 0) {
                continue
            }

            state.batches[candidate.leftBatch] = state.batches[
                candidate.leftBatch
            ].map((index) =>
                index === candidate.left ? candidate.right : index
            )
            state.batches[candidate.rightBatch] = state.batches[
                candidate.rightBatch
            ].map((index) =>
                index === candidate.right ? candidate.left : index
            )
            state.batchOf[candidate.left] = candidate.rightBatch
            state.batchOf[candidate.right] = candidate.leftBatch

            for (let other = 0; other < entryCount; other++) {
                state.gains[other * batchCount + candidate.leftBatch] +=
                    similarityAt(
                        similarities,
                        entryCount,
                        other,
                        candidate.right
                    ) -
                    similarityAt(
                        similarities,
                        entryCount,
                        other,
                        candidate.left
                    )
                state.gains[other * batchCount + candidate.rightBatch] +=
                    similarityAt(
                        similarities,
                        entryCount,
                        other,
                        candidate.left
                    ) -
                    similarityAt(
                        similarities,
                        entryCount,
                        other,
                        candidate.right
                    )
            }
            usedEntries.add(candidate.left)
            usedEntries.add(candidate.right)
            changed = true
        }

        if (!changed) {
            break
        }
    }
}

export const partitionDreamEntries = (
    inputEntries: readonly MemoryEntryRecord[]
): MemoryEntryRecord[][] => {
    if (inputEntries.length === 0) {
        return []
    }

    const entries = [...inputEntries].sort((left, right) =>
        compareIds(left.id, right.id)
    )
    const batchCount = selectDreamPartitionCount(entries.length)
    const targetSizes = buildTargetSizes(entries.length, batchCount)
    const { degrees, similarities } = buildSimilarityData(entries)
    let best: PartitionCandidate | null = null

    const attemptCount = Math.min(PARTITION_ATTEMPTS, entries.length)
    for (let attempt = 0; attempt < attemptCount; attempt++) {
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
        if (best == null || quality > best.quality) {
            best = {
                batches: state.batches.map((batch) => [...batch]),
                quality
            }
        }
    }

    const bestState: PartitionState = {
        batches: best?.batches.map((batch) => [...batch]) ?? [],
        batchOf: new Int32Array(entries.length),
        gains: new Uint16Array(entries.length * batchCount)
    }
    bestState.batchOf.fill(-1)
    bestState.batches.forEach((batch, batchIndex) => {
        for (const entryIndex of batch) {
            bestState.batchOf[entryIndex] = batchIndex
            for (let other = 0; other < entries.length; other++) {
                bestState.gains[other * batchCount + batchIndex] +=
                    similarityAt(
                        similarities,
                        entries.length,
                        other,
                        entryIndex
                    )
            }
        }
    })
    optimizePartition(entries, similarities, degrees, targetSizes, bestState)

    return bestState.batches.map((batch) =>
        batch
            .map((entryIndex) => entries[entryIndex])
            .sort((left, right) => compareIds(left.id, right.id))
    )
}
