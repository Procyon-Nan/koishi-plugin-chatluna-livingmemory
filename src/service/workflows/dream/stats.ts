import type { DreamOperationStats } from './types'

export const createEmptyStats = (): DreamOperationStats => ({
    kept: 0,
    merged: 0,
    updated: 0,
    archived: 0,
    skipped: 0
})

export const addStats = (
    target: DreamOperationStats,
    source: DreamOperationStats
) => {
    target.kept += source.kept
    target.merged += source.merged
    target.updated += source.updated
    target.archived += source.archived
    target.skipped += source.skipped
}

export const formatDreamDetail = (
    entryCount: number,
    clusterCount: number,
    stats: DreamOperationStats
) => {
    return [
        `dream active: scanned ${entryCount}`,
        `clusters ${clusterCount}`,
        `merged ${stats.merged}`,
        `updated ${stats.updated}`,
        `archived ${stats.archived}`,
        `skipped ${stats.skipped}`
    ].join(', ')
}
