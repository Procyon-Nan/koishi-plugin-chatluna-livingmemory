import { MemoryInputError } from '../../../memory/errors'
import type { DreamBatch, DreamOperationStats } from '../types'

interface DreamBatchCoverage {
    batchId: string
    targetCount: number
    processedCount: number
    unprocessedMemoryIds: string[]
}

export interface DreamSessionState {
    mode: 'full' | 'incremental'
    completedBatches: DreamBatchCoverage[]
    untouchedSeedIds: string[]
    profileSpeakerKeys?: Set<string>
    batches: readonly DreamBatch[]
    nextBatchIndex: number
    currentBatch: DreamBatch | undefined
    readonly targetMemoryIds: ReadonlySet<string>
    availableMemoryIds: Set<string>
    processedMemoryIds: Set<string>
    stats: DreamOperationStats
    skippedBatches: { batchId: string; memoryIds: string[]; reason: string }[]
}

export function createDreamSessionState(
    targetMemoryIds: readonly string[],
    mode: DreamSessionState['mode'] = 'full'
): DreamSessionState {
    return {
        mode,
        completedBatches: [],
        untouchedSeedIds: [],
        batches: [],
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
    if (state.mode === 'incremental' && state.currentBatch !== undefined) {
        state.completedBatches.push(currentBatchCoverage(state))
    }
    state.currentBatch = undefined
    while (state.nextBatchIndex < state.batches.length) {
        const batch = state.batches[state.nextBatchIndex++]
        const entries =
            state.mode === 'full'
                ? batch.entries.filter(
                      (entry) => !state.processedMemoryIds.has(entry.id)
                  )
                : batch.entries
        if (state.mode === 'incremental') {
            state.processedMemoryIds.clear()
            state.availableMemoryIds.clear()
        }
        if (entries.length === 0) {
            continue
        }
        for (const entry of entries) {
            state.availableMemoryIds.add(entry.id)
        }
        state.currentBatch = { ...batch, entries }
        break
    }
    return state.currentBatch
}

export function pendingDreamMemoryIds(state: DreamSessionState): string[] {
    const entries = state.currentBatch!.entries
    return entries
        .filter((entry) => !state.processedMemoryIds.has(entry.id))
        .map((entry) => entry.id)
}

export function assertDreamMemoriesAvailable(
    state: DreamSessionState,
    ids: readonly string[]
) {
    const missing = ids.filter((id) => !state.availableMemoryIds.has(id))
    if (missing.length > 0) {
        throw new MemoryInputError(
            `请使用${state.mode === 'incremental' ? '当前组' : '本次会话'}已提供的记忆 ID，以下 ID 需核对：${missing.join('、')}。`
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
    state.skippedBatches.push({
        batchId: state.currentBatch!.id,
        memoryIds: pendingDreamMemoryIds(state),
        reason
    })
}

function currentBatchCoverage(state: DreamSessionState): DreamBatchCoverage {
    const pending = pendingDreamMemoryIds(state)
    return {
        batchId: state.currentBatch!.id,
        targetCount: state.currentBatch!.entries.length,
        processedCount: state.currentBatch!.entries.length - pending.length,
        unprocessedMemoryIds: pending
    }
}

export function getDreamCoverage(state: DreamSessionState) {
    if (state.mode === 'incremental') {
        const coverage = [...state.completedBatches]
        if (state.currentBatch !== undefined)
            coverage.push(currentBatchCoverage(state))
        // 提前终止时，尚未进入会话的组仍属于本次计划中的未完成项。
        for (const batch of state.batches.slice(state.nextBatchIndex)) {
            coverage.push({
                batchId: batch.id,
                targetCount: batch.entries.length,
                processedCount: 0,
                unprocessedMemoryIds: batch.entries.map((entry) => entry.id)
            })
        }
        return {
            targetCount: coverage.reduce(
                (sum, batch) => sum + batch.targetCount,
                0
            ),
            processedCount: coverage.reduce(
                (sum, batch) => sum + batch.processedCount,
                0
            ),
            unprocessedMemoryIds: coverage.flatMap(
                (batch) => batch.unprocessedMemoryIds
            )
        }
    }
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

export function recordDreamProfileSpeakers(
    state: DreamSessionState,
    speakerKeys: readonly string[]
) {
    if (state.profileSpeakerKeys === undefined) return
    for (const key of speakerKeys) state.profileSpeakerKeys.add(key)
}
