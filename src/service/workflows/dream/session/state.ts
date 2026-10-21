import type { DreamCluster, DreamOperationStats } from '../types'

export interface DreamSessionState {
    clusters: readonly DreamCluster[]
    nextBatchIndex: number
    currentBatch: DreamCluster | undefined
    readonly targetMemoryIds: ReadonlySet<string>
    availableMemoryIds: Set<string>
    processedMemoryIds: Set<string>
    stats: DreamOperationStats
    skippedBatches: { batchId: string; memoryIds: string[]; reason: string }[]
}

export function createDreamSessionState(
    targetMemoryIds: readonly string[]
): DreamSessionState {
    return {
        clusters: [],
        nextBatchIndex: 0,
        currentBatch: undefined,
        targetMemoryIds: new Set(targetMemoryIds),
        availableMemoryIds: new Set(),
        processedMemoryIds: new Set(),
        stats: {
            kept: 0,
            merged: 0,
            split: 0,
            updated: 0,
            archived: 0
        },
        skippedBatches: []
    }
}

export function advanceDreamBatch(state: DreamSessionState) {
    state.currentBatch = undefined
    while (state.nextBatchIndex < state.clusters.length) {
        const cluster = state.clusters[state.nextBatchIndex++]
        const entries = cluster.entries.filter(
            (entry) => !state.processedMemoryIds.has(entry.id)
        )
        if (entries.length === 0) {
            continue
        }
        for (const entry of entries) {
            state.availableMemoryIds.add(entry.id)
        }
        state.currentBatch = { ...cluster, entries }
        break
    }
    return state.currentBatch
}

export function pendingDreamMemoryIds(state: DreamSessionState): string[] {
    return (state.currentBatch?.entries ?? [])
        .filter((entry) => !state.processedMemoryIds.has(entry.id))
        .map((entry) => entry.id)
}

export function assertDreamMemoriesAvailable(
    state: DreamSessionState,
    ids: readonly string[]
) {
    const missing = ids.filter((id) => !state.availableMemoryIds.has(id))
    if (missing.length > 0) {
        throw new Error(
            `请使用本次会话已提供的记忆 ID，以下 ID 需核对：${missing.join('、')}。`
        )
    }
}

export function recordDreamOperation(
    state: DreamSessionState,
    ids: readonly string[],
    operation: 'kept' | 'updated' | 'merged' | 'split' | 'archived'
) {
    for (const id of ids) {
        state.processedMemoryIds.add(id)
    }
    if (operation === 'merged' || operation === 'split') {
        state.stats[operation]++
        state.stats.archived += ids.length
    } else {
        state.stats[operation] += ids.length
    }
}

export function recordSkippedDreamBatch(
    state: DreamSessionState,
    reason: string
) {
    const memoryIds = pendingDreamMemoryIds(state)
    if (state.currentBatch !== undefined && memoryIds.length > 0) {
        state.skippedBatches.push({
            batchId: state.currentBatch.id,
            memoryIds,
            reason
        })
    }
}

export function getDreamCoverage(state: DreamSessionState) {
    const unprocessedMemoryIds = [...state.targetMemoryIds].filter(
        (id) => !state.processedMemoryIds.has(id)
    )
    return {
        targetCount: state.targetMemoryIds.size,
        processedCount:
            state.targetMemoryIds.size - unprocessedMemoryIds.length,
        unprocessedMemoryIds
    }
}
