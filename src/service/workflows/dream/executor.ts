import type {
    MemoryEntryRecord,
    MemoryMutationInput,
    MemorySourceOrigin
} from '../../../contracts/memory'
import type { ExtractionRepository } from '../../../contracts/workflows'
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
    'deleteMemory' | 'updateMemory'
> & {
    updateMemorySourceOrigins(
        id: string,
        sourceOrigins: MemorySourceOrigin[]
    ): Promise<void>
}

export class DreamExecutor {
    constructor(private readonly repository: DreamExecutorRepository) {}

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
            if (
                !this.isActionAllowed(stage, operation.action) ||
                !this.operationIdsWithinCluster(operation, entryById)
            ) {
                stats.skipped++
                continue
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
                        stats
                    )
                    break
                case 'archive':
                    await this.executeArchive(
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats
                    )
                    break
                case 'merge':
                    await this.executeMerge(
                        stage,
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats,
                        mergeDeletedSourceIds
                    )
                    break
                case 'deleteSource':
                    this.executeDeleteSource(
                        operation,
                        mergeDeletedSourceIds,
                        stats
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
        stats: DreamOperationStats
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
        }
    }

    private async executeUpdate(
        stage: DreamStage,
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>,
        touchedMemoryIds: Set<string>,
        stats: DreamOperationStats
    ) {
        const memoryId = operation.memoryId
        const entry =
            typeof memoryId === 'string' ? entryById.get(memoryId) : null
        if (entry == null || touchedMemoryIds.has(entry.id)) {
            stats.skipped++
            return
        }

        const patch = this.sanitizeMemoryPatch(operation.memory)
        this.assertCompleteMetadataForNewContent(operation, patch)

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
        stats: DreamOperationStats
    ) {
        const memoryId = operation.memoryId
        const entry =
            typeof memoryId === 'string' ? entryById.get(memoryId) : null
        if (entry == null || touchedMemoryIds.has(entry.id)) {
            stats.skipped++
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
        mergeDeletedSourceIds: Set<string>
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

        if (
            target == null ||
            touchedMemoryIds.has(target.id) ||
            sources.length === 0 ||
            sources.some((entry) => touchedMemoryIds.has(entry.id))
        ) {
            stats.skipped++
            return
        }

        const patch = this.sanitizeMemoryPatch(operation.memory)
        this.assertCompleteMetadataForNewContent(operation, patch)
        const sourceOrigins = mergeMemorySourceOrigins([target, ...sources])

        await this.repository.updateMemory(
            target.id,
            this.prepareStagePatch(stage, patch)
        )
        await this.repository.updateMemorySourceOrigins(
            target.id,
            sourceOrigins
        )
        touchedMemoryIds.add(target.id)
        stats.merged++

        for (const source of sources) {
            if (stage === 'archived') {
                await this.repository.deleteMemory(source.id)
                touchedMemoryIds.add(source.id)
                mergeDeletedSourceIds.add(source.id)
                stats.deleted++
            } else {
                await this.archiveMemory(source, touchedMemoryIds)
                stats.archived++
            }
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
        patch: Partial<MemoryMutationInput>
    ): Partial<MemoryMutationInput> {
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
    ): Partial<MemoryMutationInput> {
        if (memory == null || typeof memory !== 'object') {
            return {}
        }

        const patch: Partial<MemoryMutationInput> = {}
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

    private assertCompleteMetadataForNewContent(
        operation: DreamOperation,
        patch: Partial<MemoryMutationInput>
    ) {
        if (
            patch.type == null ||
            patch.content == null ||
            patch.summary == null ||
            (patch.keywords?.length ?? 0) === 0 ||
            patch.sentiment == null ||
            patch.importance == null
        ) {
            throw new Error(
                `dream ${operation.action} failed: generated memory is incomplete`
            )
        }
    }
}
