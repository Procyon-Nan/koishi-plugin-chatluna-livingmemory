import type { MemoryEntryRecord } from '../../../contracts/memory'
import type {
    DreamMergeMutation,
    DreamMergeRepository,
    ExtractionRepository
} from '../../../contracts/workflows'
import {
    normalizeMemoryImportance,
    normalizeMemoryKeywords,
    normalizeMemoryText,
    normalizeOptionalMemoryText
} from '../../memory/entry_fields'
import { mergeMemorySourceOrigins } from '../../memory/origins/source_origins'
import { createEmptyStats } from './stats'
import type {
    DreamAction,
    DreamCluster,
    DreamOperation,
    DreamOperationStats,
    DreamStage
} from './types'
import { isMemoryEntryType, unique } from './util'

export type DreamExecutorRepository = Pick<
    ExtractionRepository,
    'updateMemory'
> &
    DreamMergeRepository

type DreamGeneratedMemoryMutation = Omit<DreamMergeMutation, 'status'>

export class DreamExecutor {
    constructor(
        private readonly repository: DreamExecutorRepository,
        private readonly debug: (message: string) => void
    ) {}

    async executeOperations(
        stage: DreamStage,
        cluster: DreamCluster,
        operations: DreamOperation[],
        touchedMemoryIds: Set<string>
    ): Promise<DreamOperationStats> {
        const stats = createEmptyStats()
        const entryById = new Map(
            cluster.entries.map((entry) => [entry.id, entry])
        )
        const mergeDeletedSourceIds = new Set<string>()

        for (const operation of operations) {
            if (!this.isActionAllowed(stage, operation.action)) {
                stats.skipped++
                this.debug(
                    this.formatSkipLog(
                        stage,
                        cluster.id,
                        operation.action,
                        'action-not-allowed-in-stage'
                    )
                )
                continue
            }
            if (!this.operationIdsWithinCluster(operation, entryById)) {
                stats.skipped++
                this.debug(
                    this.formatSkipLog(
                        stage,
                        cluster.id,
                        operation.action,
                        'ids-not-in-cluster'
                    )
                )
                continue
            }

            const logSkip = (reason: string) => {
                this.debug(
                    this.formatSkipLog(
                        stage,
                        cluster.id,
                        operation.action,
                        reason
                    )
                )
            }

            switch (operation.action) {
                case 'keep':
                    stats.kept++
                    break
                case 'update':
                    await this.executeUpdate(
                        stage,
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats,
                        logSkip
                    )
                    break
                case 'archive':
                    await this.executeArchive(
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats,
                        logSkip
                    )
                    break
                case 'merge':
                    await this.executeMerge(
                        stage,
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats,
                        mergeDeletedSourceIds,
                        logSkip
                    )
                    break
                case 'deleteSource':
                    this.executeDeleteSource(
                        operation,
                        mergeDeletedSourceIds,
                        stats,
                        logSkip
                    )
                    break
            }
        }

        return stats
    }

    private isActionAllowed(stage: DreamStage, action: DreamAction) {
        if (stage === 'active') {
            return (
                action === 'keep' ||
                action === 'update' ||
                action === 'merge' ||
                action === 'archive'
            )
        }

        return (
            action === 'keep' ||
            action === 'update' ||
            action === 'merge' ||
            action === 'deleteSource'
        )
    }

    private operationIdsWithinCluster(
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>
    ) {
        return this.extractOperationIds(operation).every((id) =>
            entryById.has(id)
        )
    }

    private extractOperationIds(operation: DreamOperation) {
        return unique(
            [
                operation.memoryId,
                operation.targetMemoryId,
                ...(Array.isArray(operation.memoryIds)
                    ? operation.memoryIds
                    : []),
                ...(Array.isArray(operation.sourceMemoryIds)
                    ? operation.sourceMemoryIds
                    : [])
            ].filter((id): id is string => typeof id === 'string')
        )
    }

    private executeDeleteSource(
        operation: DreamOperation,
        mergeDeletedSourceIds: Set<string>,
        stats: DreamOperationStats,
        logSkip: (reason: string) => void
    ) {
        const sourceIds = Array.isArray(operation.sourceMemoryIds)
            ? operation.sourceMemoryIds.filter(
                  (id): id is string => typeof id === 'string'
              )
            : []
        if (
            sourceIds.length === 0 ||
            !sourceIds.every((id) => mergeDeletedSourceIds.has(id))
        ) {
            stats.skipped++
            logSkip('deleteSource-without-prior-merge')
        }
    }

    private async executeUpdate(
        stage: DreamStage,
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>,
        touchedMemoryIds: Set<string>,
        stats: DreamOperationStats,
        logSkip: (reason: string) => void
    ) {
        const memoryId = operation.memoryId
        const entry =
            typeof memoryId === 'string' ? entryById.get(memoryId) : null
        if (entry == null) {
            stats.skipped++
            logSkip('entry-not-found')
            return
        }
        if (touchedMemoryIds.has(entry.id)) {
            stats.skipped++
            logSkip('already-touched')
            return
        }

        const patch = this.sanitizeMemoryPatch(operation.memory)
        if (!this.hasCompleteMetadata(patch)) {
            stats.skipped++
            logSkip('incomplete-metadata')
            return
        }

        await this.repository.updateMemory(
            entry.id,
            this.prepareStagePatch(stage, patch)
        )
        touchedMemoryIds.add(entry.id)
        stats.updated++
    }

    private async executeArchive(
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>,
        touchedMemoryIds: Set<string>,
        stats: DreamOperationStats,
        logSkip: (reason: string) => void
    ) {
        const memoryId = operation.memoryId
        const entry =
            typeof memoryId === 'string' ? entryById.get(memoryId) : null
        if (entry == null) {
            stats.skipped++
            logSkip('entry-not-found')
            return
        }
        if (touchedMemoryIds.has(entry.id)) {
            stats.skipped++
            logSkip('already-touched')
            return
        }

        await this.archiveMemory(entry, touchedMemoryIds)
        stats.archived++
    }

    private async executeMerge(
        stage: DreamStage,
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>,
        touchedMemoryIds: Set<string>,
        stats: DreamOperationStats,
        mergeDeletedSourceIds: Set<string>,
        logSkip: (reason: string) => void
    ) {
        const targetId = operation.targetMemoryId
        const target =
            typeof targetId === 'string' ? entryById.get(targetId) : null
        const sourceIds = unique(
            [
                ...(Array.isArray(operation.sourceMemoryIds)
                    ? operation.sourceMemoryIds
                    : []),
                ...(Array.isArray(operation.memoryIds)
                    ? operation.memoryIds
                    : [])
            ].filter((id): id is string => typeof id === 'string')
        ).filter((id) => id !== targetId)
        const sources = sourceIds
            .map((id) => entryById.get(id))
            .filter((entry): entry is MemoryEntryRecord => entry != null)

        if (target == null) {
            stats.skipped++
            logSkip('merge-target-not-found')
            return
        }
        if (touchedMemoryIds.has(target.id)) {
            stats.skipped++
            logSkip('merge-target-already-touched')
            return
        }
        if (sources.length === 0) {
            stats.skipped++
            logSkip('merge-no-valid-sources')
            return
        }
        if (sources.some((entry) => touchedMemoryIds.has(entry.id))) {
            stats.skipped++
            logSkip('merge-source-already-touched')
            return
        }

        const patch = this.sanitizeMemoryPatch(operation.memory)
        if (!this.hasCompleteMetadata(patch)) {
            stats.skipped++
            logSkip('incomplete-metadata')
            return
        }
        const sourceOrigins = mergeMemorySourceOrigins([target, ...sources])
        const sourceMemoryIds = sources.map((source) => source.id)

        await this.repository.applyDreamMerge({
            target: {
                id: target.id,
                updatedAt: target.updatedAt
            },
            sources: sources.map((source) => ({
                id: source.id,
                updatedAt: source.updatedAt
            })),
            patch: this.prepareStagePatch(stage, patch),
            sourceOrigins,
            sourceDisposition: stage === 'archived' ? 'delete' : 'archive'
        })

        touchedMemoryIds.add(target.id)
        sourceMemoryIds.forEach((id) => touchedMemoryIds.add(id))
        stats.merged++

        if (stage === 'archived') {
            sourceMemoryIds.forEach((id) => mergeDeletedSourceIds.add(id))
            stats.deleted += sourceMemoryIds.length
        } else {
            stats.archived += sourceMemoryIds.length
        }
    }

    private async archiveMemory(
        entry: MemoryEntryRecord,
        touchedMemoryIds: Set<string>
    ) {
        await this.repository.updateMemory(entry.id, {
            status: 'archived'
        })
        touchedMemoryIds.add(entry.id)
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

    private sanitizeMemoryPatch(
        memory: Record<string, unknown> | undefined
    ): Partial<DreamGeneratedMemoryMutation> {
        if (memory == null || typeof memory !== 'object') {
            return {}
        }

        const patch: Partial<DreamGeneratedMemoryMutation> = {}
        if (typeof memory.type === 'string' && isMemoryEntryType(memory.type)) {
            patch.type = memory.type
        }

        if (typeof memory.content === 'string') {
            const content = normalizeMemoryText(memory.content)
            if (content.length > 0) {
                patch.content = content
            }
        }

        if (typeof memory.summary === 'string') {
            patch.summary = normalizeOptionalMemoryText(memory.summary)
        }

        if (Array.isArray(memory.keywords)) {
            const keywords = normalizeMemoryKeywords(memory.keywords)
            if (keywords.length > 0) {
                patch.keywords = keywords
            }
        }

        if (typeof memory.sentiment === 'string') {
            patch.sentiment = normalizeOptionalMemoryText(memory.sentiment)
        }

        if (Object.prototype.hasOwnProperty.call(memory, 'importance')) {
            patch.importance = normalizeMemoryImportance(memory.importance)
        }

        return patch
    }

    private hasCompleteMetadata(
        patch: Partial<DreamGeneratedMemoryMutation>
    ): patch is DreamGeneratedMemoryMutation {
        return (
            patch.type != null &&
            patch.content != null &&
            patch.summary != null &&
            (patch.keywords?.length ?? 0) > 0 &&
            patch.sentiment != null &&
            patch.importance != null
        )
    }

    private formatSkipLog(
        stage: DreamStage,
        clusterId: string,
        action: string,
        reason: string
    ): string {
        return [
            'memory dream operation skipped:',
            `stage=${stage}`,
            `clusterId=${clusterId}`,
            `action=${action}`,
            `reason=${reason}`
        ].join(' ')
    }
}
