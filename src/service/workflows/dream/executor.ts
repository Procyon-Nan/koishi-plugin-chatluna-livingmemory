import type {
    DreamMemoryEntryRecord,
    DreamMemoryRepository,
    DreamMemoryMutation
} from '../../../contracts/workflows'
import type { PresetSpeakerRecord } from '../../../contracts/memory'
import { normalizeMemoryKeywords } from '../../memory/entry_fields'
import type { LivingMemoryLogger } from '../../logging/logger'
import { resolveSpeakerKeysByLabels } from '../../memory/speaker_identity'
import { createEmptyStats } from './stats'
import type {
    DreamCluster,
    DreamConsolidationMode,
    DreamExecutionResult,
    DreamOperation,
    DreamOperationStats
} from './types'

export type DreamExecutorRepository = DreamMemoryRepository

type DreamUpdateOperation = Extract<DreamOperation, { action: 'update' }>
type DreamArchiveOperation = Extract<DreamOperation, { action: 'archive' }>
type DreamMergeOperation = Extract<DreamOperation, { action: 'merge' }>

interface DreamExecutionState {
    entryById: Map<string, DreamMemoryEntryRecord>
    touchedMemoryIds: Set<string>
    stats: DreamOperationStats
    consolidationMode: DreamConsolidationMode
    speakers: PresetSpeakerRecord[]
    consolidatedMemoryIds: Set<string>
    mutatedMemoryIds: Set<string>
}

export const getDreamOperationMemoryIds = (operation: DreamOperation) => {
    switch (operation.action) {
        case 'keep':
            return operation.memoryIds
        case 'update':
        case 'archive':
            return [operation.memoryId]
        case 'merge':
            return [operation.targetMemoryId, ...operation.sourceMemoryIds]
    }
}

export class DreamExecutor {
    constructor(private readonly repository: DreamExecutorRepository) {}

    async executeOperations(
        presetId: string,
        cluster: DreamCluster,
        operations: DreamOperation[],
        touchedMemoryIds: Set<string>,
        consolidationMode: DreamConsolidationMode,
        speakers: PresetSpeakerRecord[],
        logger?: LivingMemoryLogger
    ): Promise<DreamExecutionResult> {
        const stats = createEmptyStats()
        const consolidatedMemoryIds = new Set<string>()
        const mutatedMemoryIds = new Set<string>()
        const entryById = new Map(
            cluster.entries.map((entry) => [entry.id, entry])
        )
        const state: DreamExecutionState = {
            entryById,
            touchedMemoryIds,
            stats,
            consolidationMode,
            speakers,
            consolidatedMemoryIds,
            mutatedMemoryIds
        }

        for (const operation of operations) {
            if (!this.operationIdsWithinCluster(operation, entryById)) {
                stats.skipped++
                this.logSkip(
                    logger,
                    presetId,
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

        const patch = this.prepareMemoryPatch(operation.memory, state.speakers)

        const isConsolidated = state.consolidationMode !== 'incremental-batch'
        await this.repository.updateMemoryForDream(
            entry.presetId,
            entry.id,
            patch,
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

        const patch = this.prepareMemoryPatch(operation.memory, state.speakers)
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
            patch,
            targetIsConsolidated:
                state.consolidationMode !== 'incremental-batch'
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
        state.stats.archived += sourceMemoryIds.length
    }

    private async archiveMemory(
        entry: DreamMemoryEntryRecord,
        touchedMemoryIds: Set<string>
    ) {
        await this.repository.updateMemoryForDream(
            entry.presetId,
            entry.id,
            { status: 'archived' }
        )
        touchedMemoryIds.add(entry.id)
    }

    private prepareMemoryPatch(
        memory: DreamUpdateOperation['memory'],
        speakers: PresetSpeakerRecord[]
    ): DreamMemoryMutation {
        const { speakerLabels, ...fields } = memory
        return {
            ...fields,
            speakerKeys: resolveSpeakerKeysByLabels(speakerLabels, speakers),
            keywords: normalizeMemoryKeywords(fields.keywords)
        }
    }

    private logSkip(
        logger: LivingMemoryLogger | undefined,
        presetId: string,
        clusterId: string,
        action: string,
        reason: string
    ) {
        logger?.diagnostic('dream.operation.skipped', {
            presetId,
            clusterId,
            action,
            reason
        })
    }
}
