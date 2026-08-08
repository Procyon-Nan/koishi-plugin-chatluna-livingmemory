import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import { selectBestInitialPartition } from './partitioning/initial'
import { optimizePartition } from './partitioning/optimization'
import { buildSimilarityData, compareEntryIds } from './partitioning/similarity'

export const DREAM_PARTITION_TARGET_SIZE = 300
export const DREAM_PARTITION_MAX_SIZE = 350

const PARTITION_ATTEMPTS = 3

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

export const buildDreamPartitionTargetSizes = (
    entryCount: number,
    batchCount: number
) => {
    const baseSize = Math.floor(entryCount / batchCount)
    const largerBatchCount = entryCount % batchCount
    return Array.from({ length: batchCount }, (_, index) => {
        if (index < largerBatchCount) {
            return baseSize + 1
        }
        return baseSize
    })
}

export const partitionDreamEntries = (
    inputEntries: readonly DreamMemoryEntryRecord[]
): DreamMemoryEntryRecord[][] => {
    if (inputEntries.length === 0) {
        return []
    }

    const entries = [...inputEntries].sort((left, right) =>
        compareEntryIds(left.id, right.id)
    )
    const batchCount = selectDreamPartitionCount(entries.length)
    const targetSizes = buildDreamPartitionTargetSizes(
        entries.length,
        batchCount
    )
    const { degrees, similarities } = buildSimilarityData(entries)
    const { state } = selectBestInitialPartition(
        entries,
        similarities,
        degrees,
        targetSizes,
        Math.min(PARTITION_ATTEMPTS, entries.length)
    )
    optimizePartition(entries, similarities, degrees, targetSizes, state)

    return state.batches.map((batch) =>
        batch
            .map((entryIndex) => entries[entryIndex])
            .sort((left, right) => compareEntryIds(left.id, right.id))
    )
}
