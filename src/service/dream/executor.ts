import type { MemoryEntryRecord, MemoryMutationInput } from '../../types'
import type { LivingMemoryRepository } from '../repository'
import { createEmptyStats } from './stats'
import type {
    DreamAction,
    DreamCluster,
    DreamOperation,
    DreamOperationStats,
    DreamStage
} from './types'
import {
    isMemoryEntryType,
    normalizeText,
    parseImportance,
    unique
} from './util'

export class DreamExecutor {
    constructor(private readonly repository: LivingMemoryRepository) {}

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

        const patch = this.regenerateKeywordsFromContent(
            this.sanitizeMemoryPatch(operation.memory, entry)
        )
        if (Object.keys(patch).length === 0) {
            stats.skipped++
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
        stats: DreamOperationStats
    ) {
        const memoryId = operation.memoryId
        const entry =
            typeof memoryId === 'string' ? entryById.get(memoryId) : null
        if (entry == null || touchedMemoryIds.has(entry.id)) {
            stats.skipped++
            return
        }

        await this.archiveMemory(
            entry,
            touchedMemoryIds,
            this.sanitizeMemoryPatch(operation.memory, entry)
        )
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
                    : []),
                targetId
            ].filter((id): id is string => typeof id === 'string')
        )
        const sources = sourceIds
            .map((id) => entryById.get(id))
            .filter((entry): entry is MemoryEntryRecord => entry != null)

        if (
            target == null ||
            sources.length < 2 ||
            sources.some((entry) => touchedMemoryIds.has(entry.id))
        ) {
            stats.skipped++
            return
        }

        const patch = this.sanitizeMemoryPatch(operation.memory, target)
        if (patch.content == null || patch.content.trim().length === 0) {
            stats.skipped++
            return
        }
        // importance：原先取所有 source 的 max，反复 merge 会令 target 重要度
        // 单调非减、持续抬高。改为取 source 群（含 target 自身）的均值，使重复
        // 合并收敛而非膨胀。模型在 merge 操作中显式给出 importance 时尊重其判断，
        // 否则用均值。source 与模型值均已在 [0,1] 内，均值无需再钳。
        patch.importance =
            patch.importance ??
            sources.reduce(
                (sum, source) => sum + (source.importance ?? 0.5),
                0
            ) / sources.length
        this.regenerateKeywordsFromContent(patch)

        await this.repository.updateMemory(
            target.id,
            this.prepareStagePatch(stage, patch)
        )
        touchedMemoryIds.add(target.id)
        stats.merged++

        for (const source of sources) {
            if (source.id === target.id || touchedMemoryIds.has(source.id)) {
                continue
            }

            if (stage === 'archived') {
                await this.repository.deleteMemory(source.id)
                touchedMemoryIds.add(source.id)
                mergeDeletedSourceIds.add(source.id)
                stats.deleted++
            } else {
                await this.archiveMemory(source, touchedMemoryIds, {
                    status: 'archived',
                    content: source.content,
                    summary: source.summary,
                    keywords: source.keywords,
                    sentiment: source.sentiment,
                    importance: Math.min(source.importance ?? 0.5, 0.35)
                })
                stats.archived++
            }
        }
    }

    private async archiveMemory(
        entry: MemoryEntryRecord,
        touchedMemoryIds: Set<string>,
        patch: Partial<MemoryMutationInput>
    ) {
        await this.repository.updateMemory(entry.id, {
            ...patch,
            status: 'archived',
            content: normalizeText(patch.content ?? entry.content),
            summary:
                patch.summary ?? entry.summary ?? entry.content.slice(0, 80),
            keywords: unique(
                patch.keywords?.length ? patch.keywords : entry.keywords
            ).slice(0, 12),
            sentiment: patch.sentiment ?? entry.sentiment,
            importance:
                patch.importance ?? Math.min(entry.importance ?? 0.5, 0.35)
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
        memory: Record<string, unknown> | undefined,
        fallback: MemoryEntryRecord
    ): Partial<MemoryMutationInput> {
        if (memory == null || typeof memory !== 'object') {
            return {}
        }

        const patch: Partial<MemoryMutationInput> = {}
        if (typeof memory.type === 'string' && isMemoryEntryType(memory.type)) {
            patch.type = memory.type
        }

        if (typeof memory.content === 'string') {
            const content = normalizeText(memory.content)
            if (content.length > 0) {
                patch.content = content
            }
        }

        if (typeof memory.summary === 'string') {
            const summary = normalizeText(memory.summary)
            patch.summary = summary.length > 0 ? summary : null
        }

        if (Array.isArray(memory.keywords)) {
            const keywords = unique(
                memory.keywords
                    .filter(
                        (keyword): keyword is string =>
                            typeof keyword === 'string'
                    )
                    .map(normalizeText)
                    .filter(Boolean)
            ).slice(0, 12)
            if (keywords.length > 0) {
                patch.keywords = keywords
            }
        }

        if (typeof memory.sentiment === 'string') {
            const sentiment = normalizeText(memory.sentiment)
            patch.sentiment = sentiment.length > 0 ? sentiment : null
        }

        if (Object.prototype.hasOwnProperty.call(memory, 'importance')) {
            patch.importance = parseImportance(memory.importance)
        }

        if (patch.content != null && patch.keywords == null) {
            patch.keywords = fallback.keywords
        }

        return patch
    }

    private regenerateKeywordsFromContent(patch: Partial<MemoryMutationInput>) {
        delete patch.keywords

        return patch
    }
}
