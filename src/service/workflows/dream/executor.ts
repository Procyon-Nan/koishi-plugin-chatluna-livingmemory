import type {
    DreamMemoryEntryRecord,
    DreamMemoryRepository,
    DreamMergeMutation
} from '../../../contracts/workflows'
import { normalizeMemoryKeywords } from '../../memory/entry_fields'
import type { LivingMemoryLogger } from '../../logging/logger'
import { createEmptyStats } from './stats'
import type {
    DreamCluster,
    DreamConsolidationMode,
    DreamExecutionResult,
    DreamOperation,
    DreamOperationStats,
    DreamStage
} from './types'

export type DreamExecutorRepository = DreamMemoryRepository

type DreamGeneratedMemoryMutation = Omit<DreamMergeMutation, 'status'>
type DreamUpdateOperation = Extract<DreamOperation, { action: 'update' }>
type DreamArchiveOperation = Extract<DreamOperation, { action: 'archive' }>
type DreamMergeOperation = Extract<DreamOperation, { action: 'merge' }>
type DreamDeleteSourceOperation = Extract<
    DreamOperation,
    { action: 'deleteSource' }
>

interface DreamExecutionState {
    stage: DreamStage
    entryById: Map<string, DreamMemoryEntryRecord>
    touchedMemoryIds: Set<string>
    stats: DreamOperationStats
    consolidationMode: DreamConsolidationMode
    consolidatedMemoryIds: Set<string>
    mutatedMemoryIds: Set<string>
    mergeDeletedSourceIds: Set<string>
}

export const getDreamOperationMemoryIds = (operation: DreamOperation) => {
    switch (operation.action) {
        case 'keep':
            return operation.memoryIds
        case 'update':
        case 'archive':
            return [operation.memoryId]
        case 'merge':
        case 'deleteSource':
            return [operation.targetMemoryId, ...operation.sourceMemoryIds]
    }
}

export class DreamExecutor {
    constructor(private readonly repository: DreamExecutorRepository) {}

    async executeOperations(
        presetId: string,
        stage: DreamStage,
        cluster: DreamCluster,
        operations: DreamOperation[],
        touchedMemoryIds: Set<string>,
        consolidationMode: DreamConsolidationMode,
        logger?: LivingMemoryLogger
    ): Promise<DreamExecutionResult> {
        const stats = createEmptyStats()
        const consolidatedMemoryIds = new Set<string>()
        const mutatedMemoryIds = new Set<string>()
        const entryById = new Map(
            cluster.entries.map((entry) => [entry.id, entry])
        )
        const state: DreamExecutionState = {
            stage,
            entryById,
            touchedMemoryIds,
            stats,
            consolidationMode,
            consolidatedMemoryIds,
            mutatedMemoryIds,
            mergeDeletedSourceIds: new Set()
        }

        for (const operation of operations) {
            if (!this.operationIdsWithinCluster(operation, entryById)) {
                stats.skipped++
                this.logSkip(
                    logger,
                    presetId,
                    stage,
                    cluster.id,
                    operation.action,
                    'ids-not-in-cluster'
                )
                continue
            }

            const logSkip = (reason: string) => {
                this.logSkip(
                    logger,
                    presetId,
                    stage,
                    cluster.id,
                    operation.action,
                    reason
                )
            }

            switch (operation.action) {
                case 'keep':
                    stats.kept++
                    break
                case 'update':
                    await this.executeUpdate(operation, state, logSkip)
                    break
                case 'archive':
                    await this.executeArchive(operation, state, logSkip)
                    break
                case 'merge':
                    await this.executeMerge(operation, state, logSkip)
                    break
                case 'deleteSource':
                    this.executeDeleteSource(operation, state, logSkip)
                    break
            }
        }

        return {
            ...stats,
            consolidatedMemoryIds,
            mutatedMemoryIds
        }
    }

    private operationIdsWithinCluster(
        operation: DreamOperation,
        entryById: Map<string, DreamMemoryEntryRecord>
    ) {
        return getDreamOperationMemoryIds(operation).every((id) =>
            entryById.has(id)
        )
    }

    private executeDeleteSource(
        operation: DreamDeleteSourceOperation,
        state: DreamExecutionState,
        logSkip: (reason: string) => void
    ) {
        if (
            !operation.sourceMemoryIds.every((id) =>
                state.mergeDeletedSourceIds.has(id)
            )
        ) {
            state.stats.skipped++
            logSkip('deleteSource-without-prior-merge')
        }
    }

    private async executeUpdate(
        operation: DreamUpdateOperation,
        state: DreamExecutionState,
        logSkip: (reason: string) => void
    ) {
        const entry = state.entryById.get(operation.memoryId)!
        if (state.touchedMemoryIds.has(entry.id)) {
            state.stats.skipped++
            logSkip('already-touched')
            return
        }

        const patch = this.prepareMemoryPatch(operation.memory)

        const isConsolidated = state.consolidationMode !== 'incremental-batch'
        await this.repository.updateMemoryForDream(
            entry.presetId,
            entry.id,
            this.prepareStagePatch(state.stage, patch),
            isConsolidated
        )
        state.touchedMemoryIds.add(entry.id)
        state.mutatedMemoryIds.add(entry.id)
        if (isConsolidated) {
            state.consolidatedMemoryIds.add(entry.id)
        }
        state.stats.updated++
    }

    private async executeArchive(
        operation: DreamArchiveOperation,
        state: DreamExecutionState,
        logSkip: (reason: string) => void
    ) {
        const entry = state.entryById.get(operation.memoryId)!
        if (state.touchedMemoryIds.has(entry.id)) {
            state.stats.skipped++
            logSkip('already-touched')
            return
        }

        await this.archiveMemory(entry, state.touchedMemoryIds)
        state.consolidatedMemoryIds.add(entry.id)
        state.mutatedMemoryIds.add(entry.id)
        state.stats.archived++
    }

    private async executeMerge(
        operation: DreamMergeOperation,
        state: DreamExecutionState,
        logSkip: (reason: string) => void
    ) {
        const target = state.entryById.get(operation.targetMemoryId)!
        const sources = operation.sourceMemoryIds.map((id) =>
            state.entryById.get(id)!
        )

        if (state.touchedMemoryIds.has(target.id)) {
            state.stats.skipped++
            logSkip('merge-target-already-touched')
            return
        }
        if (sources.some((entry) => state.touchedMemoryIds.has(entry.id))) {
            state.stats.skipped++
            logSkip('merge-source-already-touched')
            return
        }

        const patch = this.prepareMemoryPatch(operation.memory)
        const sourceMemoryIds = sources.map((source) => source.id)

        await this.repository.applyDreamMerge({
            presetId: target.presetId,
            target: {
                id: target.id,
                updatedAt: target.updatedAt
            },
            sources: sources.map((source) => ({
                id: source.id,
                updatedAt: source.updatedAt
            })),
            patch: this.prepareStagePatch(state.stage, patch),
            sourceDisposition: this.getSourceDisposition(state.stage),
            targetIsConsolidated:
                state.consolidationMode !== 'incremental-batch',
            sourceIsConsolidated: true
        })

        state.touchedMemoryIds.add(target.id)
        sourceMemoryIds.forEach((id) => state.touchedMemoryIds.add(id))
        state.mutatedMemoryIds.add(target.id)
        sourceMemoryIds.forEach((id) => state.mutatedMemoryIds.add(id))
        if (state.consolidationMode !== 'incremental-batch') {
            state.consolidatedMemoryIds.add(target.id)
        }
        sourceMemoryIds.forEach((id) => state.consolidatedMemoryIds.add(id))
        state.stats.merged++

        if (state.stage === 'archived') {
            sourceMemoryIds.forEach((id) => state.mergeDeletedSourceIds.add(id))
            state.stats.deleted += sourceMemoryIds.length
        } else {
            state.stats.archived += sourceMemoryIds.length
        }
    }

    private async archiveMemory(
        entry: DreamMemoryEntryRecord,
        touchedMemoryIds: Set<string>
    ) {
        await this.repository.updateMemoryForDream(
            entry.presetId,
            entry.id,
            { status: 'archived' },
            true
        )
        touchedMemoryIds.add(entry.id)
    }

    private getSourceDisposition(stage: DreamStage): 'archive' | 'delete' {
        if (stage === 'active') {
            return 'archive'
        }
        return 'delete'
    }

    private prepareStagePatch(
        stage: DreamStage,
        patch: DreamGeneratedMemoryMutation
    ): DreamMergeMutation {
        if (stage === 'active') {
            return {
                ...patch,
                status: 'active'
            }
        }

        return {
            ...patch,
            status: 'archived'
        }
    }

    private prepareMemoryPatch(
        memory: DreamUpdateOperation['memory']
    ): DreamGeneratedMemoryMutation {
        return {
            ...memory,
            keywords: normalizeMemoryKeywords(memory.keywords)
        }
    }

    private logSkip(
        logger: LivingMemoryLogger | undefined,
        presetId: string,
        stage: DreamStage,
        clusterId: string,
        action: string,
        reason: string
    ) {
        logger?.diagnostic('dream.operation.skipped', {
            presetId,
            stage,
            clusterId,
            action,
            reason
        })
    }
}
