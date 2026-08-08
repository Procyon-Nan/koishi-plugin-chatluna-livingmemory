import type { DreamMemoryEntryRecord } from '../../../../contracts/workflows'
import type { PartitionState } from './initial'
import { compareEntryIds, similarityAt } from './similarity'

const LOCAL_OPTIMIZATION_ROUNDS = 4

interface MoveCandidate {
    entryIndex: number
    sourceBatch: number
    targetBatch: number
    delta: number
}

interface SwapCandidate {
    left: number
    right: number
    leftBatch: number
    rightBatch: number
    delta: number
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

const collectMoveCandidates = (
    entries: readonly DreamMemoryEntryRecord[],
    state: PartitionState,
    targetSizes: readonly number[],
    smallerSize: number,
    largerSize: number
) => {
    if (!targetSizes.some((size) => size === largerSize)) {
        return []
    }

    const batchCount = state.batches.length
    const candidates: MoveCandidate[] = []
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        const sourceBatch = state.batchOf[entryIndex]
        if (state.batches[sourceBatch].length !== largerSize) {
            continue
        }
        for (let targetBatch = 0; targetBatch < batchCount; targetBatch++) {
            if (state.batches[targetBatch].length !== smallerSize) {
                continue
            }
            const delta =
                state.gains[entryIndex * batchCount + targetBatch] -
                state.gains[entryIndex * batchCount + sourceBatch]
            if (delta > 0) {
                candidates.push({
                    entryIndex,
                    sourceBatch,
                    targetBatch,
                    delta
                })
            }
        }
    }
    return candidates.sort(
        (left, right) =>
            right.delta - left.delta ||
            compareEntryIds(
                entries[left.entryIndex].id,
                entries[right.entryIndex].id
            ) ||
            left.sourceBatch - right.sourceBatch ||
            left.targetBatch - right.targetBatch
    )
}

const applyMoves = (
    entries: readonly DreamMemoryEntryRecord[],
    similarities: Uint8Array,
    state: PartitionState,
    targetSizes: readonly number[],
    smallerSize: number,
    largerSize: number,
    usedEntries: Set<number>
) => {
    const batchCount = state.batches.length
    let changed = false
    for (const candidate of collectMoveCandidates(
        entries,
        state,
        targetSizes,
        smallerSize,
        largerSize
    )) {
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
            entries.length,
            candidate.entryIndex,
            candidate.sourceBatch,
            candidate.targetBatch
        )
        usedEntries.add(candidate.entryIndex)
        changed = true
    }
    return changed
}

const selectSwapCandidates = (
    entries: readonly DreamMemoryEntryRecord[],
    degrees: Uint32Array,
    state: PartitionState,
    sourceBatch: number,
    targetBatch: number,
    candidateLimit: number
) => {
    const batchCount = state.batches.length
    return [...state.batches[sourceBatch]]
        .sort((left, right) => {
            const leftScore =
                state.gains[left * batchCount + targetBatch] -
                state.gains[left * batchCount + sourceBatch]
            const rightScore =
                state.gains[right * batchCount + targetBatch] -
                state.gains[right * batchCount + sourceBatch]
            return (
                rightScore - leftScore ||
                degrees[right] - degrees[left] ||
                compareEntryIds(entries[left].id, entries[right].id)
            )
        })
        .slice(0, candidateLimit)
}

const collectSwapCandidates = (
    entries: readonly DreamMemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    state: PartitionState
) => {
    const entryCount = entries.length
    const batchCount = state.batches.length
    const candidateLimit = Math.max(
        8,
        Math.min(32, Math.ceil(Math.sqrt(entryCount / batchCount)))
    )
    const candidates: SwapCandidate[] = []

    for (let leftBatch = 0; leftBatch < batchCount; leftBatch++) {
        for (
            let rightBatch = leftBatch + 1;
            rightBatch < batchCount;
            rightBatch++
        ) {
            const leftCandidates = selectSwapCandidates(
                entries,
                degrees,
                state,
                leftBatch,
                rightBatch,
                candidateLimit
            )
            const rightCandidates = selectSwapCandidates(
                entries,
                degrees,
                state,
                rightBatch,
                leftBatch,
                candidateLimit
            )

            for (const left of leftCandidates) {
                for (const right of rightCandidates) {
                    const delta =
                        state.gains[left * batchCount + rightBatch] +
                        state.gains[right * batchCount + leftBatch] -
                        state.gains[left * batchCount + leftBatch] -
                        state.gains[right * batchCount + rightBatch] -
                        2 * similarityAt(similarities, entryCount, left, right)
                    if (delta > 0) {
                        candidates.push({
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
    return candidates.sort(
        (left, right) =>
            right.delta - left.delta ||
            compareEntryIds(entries[left.left].id, entries[right.left].id) ||
            compareEntryIds(entries[left.right].id, entries[right.right].id)
    )
}

const applySwap = (
    similarities: Uint8Array,
    entryCount: number,
    state: PartitionState,
    candidate: SwapCandidate
) => {
    const batchCount = state.batches.length
    state.batches[candidate.leftBatch] = state.batches[candidate.leftBatch].map(
        (index) => (index === candidate.left ? candidate.right : index)
    )
    state.batches[candidate.rightBatch] = state.batches[
        candidate.rightBatch
    ].map((index) => (index === candidate.right ? candidate.left : index))
    state.batchOf[candidate.left] = candidate.rightBatch
    state.batchOf[candidate.right] = candidate.leftBatch

    for (let other = 0; other < entryCount; other++) {
        state.gains[other * batchCount + candidate.leftBatch] +=
            similarityAt(similarities, entryCount, other, candidate.right) -
            similarityAt(similarities, entryCount, other, candidate.left)
        state.gains[other * batchCount + candidate.rightBatch] +=
            similarityAt(similarities, entryCount, other, candidate.left) -
            similarityAt(similarities, entryCount, other, candidate.right)
    }
}

const applySwaps = (
    entries: readonly DreamMemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    state: PartitionState,
    usedEntries: Set<number>
) => {
    const batchCount = state.batches.length
    let changed = false
    for (const candidate of collectSwapCandidates(
        entries,
        similarities,
        degrees,
        state
    )) {
        if (
            usedEntries.has(candidate.left) ||
            usedEntries.has(candidate.right) ||
            state.batchOf[candidate.left] !== candidate.leftBatch ||
            state.batchOf[candidate.right] !== candidate.rightBatch
        ) {
            continue
        }
        const delta =
            state.gains[candidate.left * batchCount + candidate.rightBatch] +
            state.gains[candidate.right * batchCount + candidate.leftBatch] -
            state.gains[candidate.left * batchCount + candidate.leftBatch] -
            state.gains[candidate.right * batchCount + candidate.rightBatch] -
            2 *
                similarityAt(
                    similarities,
                    entries.length,
                    candidate.left,
                    candidate.right
                )
        if (delta <= 0) {
            continue
        }

        applySwap(similarities, entries.length, state, candidate)
        usedEntries.add(candidate.left)
        usedEntries.add(candidate.right)
        changed = true
    }
    return changed
}

export const optimizePartition = (
    entries: readonly DreamMemoryEntryRecord[],
    similarities: Uint8Array,
    degrees: Uint32Array,
    targetSizes: readonly number[],
    state: PartitionState
) => {
    const batchCount = state.batches.length
    const smallerSize = Math.floor(entries.length / batchCount)
    const largerSize = smallerSize + 1

    // move 与 swap 在应用前都会重算收益，仅接受严格提高分区质量的操作。
    for (let round = 0; round < LOCAL_OPTIMIZATION_ROUNDS; round++) {
        const usedEntries = new Set<number>()
        const moved = applyMoves(
            entries,
            similarities,
            state,
            targetSizes,
            smallerSize,
            largerSize,
            usedEntries
        )
        const swapped = applySwaps(
            entries,
            similarities,
            degrees,
            state,
            usedEntries
        )
        if (!moved && !swapped) {
            break
        }
    }
}
