import type { DreamOperationStats, DreamStage, DreamStageResult } from './types'

export const createEmptyStats = (): DreamOperationStats => ({
    kept: 0,
    merged: 0,
    updated: 0,
    archived: 0,
    deleted: 0,
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
    target.deleted += source.deleted
    target.skipped += source.skipped
}

export const sumStats = (items: DreamOperationStats[]) => {
    const stats = createEmptyStats()
    for (const item of items) {
        addStats(stats, item)
    }
    return stats
}

export const formatStageDetail = (
    stage: DreamStage,
    entryCount: number,
    clusterCount: number,
    stats: DreamOperationStats
) => {
    if (stage === 'active') {
        return [
            `dream active: scanned ${entryCount}`,
            `clusters ${clusterCount}`,
            `merged ${stats.merged}`,
            `updated ${stats.updated}`,
            `archived ${stats.archived}`,
            `skipped ${stats.skipped}`
        ].join(', ')
    }

    return [
        `dream archived: scanned ${entryCount}`,
        `clusters ${clusterCount}`,
        `merged ${stats.merged}`,
        `updated ${stats.updated}`,
        `deleted ${stats.deleted}`,
        `skipped ${stats.skipped}`
    ].join(', ')
}

export const createEmptyStageResult = (
    stage: DreamStage,
    entryCount: number
): DreamStageResult => {
    const stats = createEmptyStats()
    return {
        stage,
        entryCount,
        clusterCount: 0,
        ...stats,
        detail: formatStageDetail(stage, entryCount, 0, stats)
    }
}
