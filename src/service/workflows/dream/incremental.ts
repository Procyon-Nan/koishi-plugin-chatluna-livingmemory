import type { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { MemoryEntryRecord } from '../../../contracts/memory'
import type {
    DreamMemoryRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import type { EmbeddingRepositoryLike } from '../../shared/embeddings'
import {
    resolveAssistantLabel,
    resolvePresetPrompt
} from '../../memory/helpers'
import { isModelConfigured } from '../../shared/utils'
import { addStats, createEmptyStats } from './stats'
import type { DreamOperationStats, DreamRunResult, DreamStage } from './types'
import { IncrementalDreamRetriever } from './incremental_retrieval'
import { DreamUnitProcessor } from './unit_processor'

type IncrementalDreamConfig = Pick<
    LivingMemoryConfig,
    'mainModel' | 'embeddingModel' | 'debug'
>

export interface IncrementalDreamRepository
    extends DreamMemoryRepository, EmbeddingRepositoryLike {
    listPendingEntries(
        presetId: string,
        limit: number
    ): Promise<MemoryEntryRecord[]>
    listConsolidatedEntries(presetId: string): Promise<MemoryEntryRecord[]>
    getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]>
    countPendingEntries(presetId: string): Promise<number>
}

export interface IncrementalDreamRunResult extends DreamRunResult {
    selectedCount: number
    seedCount: number
    successfulSeedCount: number
    failedSeedCount: number
    remainingPendingCount: number
    failed: boolean
}

interface IncrementalRunState {
    stats: DreamOperationStats
    firstRoundStats: DreamOperationStats
    secondRoundStats: DreamOperationStats
    clusterCount: number
    activeInputCount: number
    archivedInputCount: number
    seedCount: number
    successfulSeedCount: number
    failedSeedCount: number
    noCandidateSeedCount: number
    errors: string[]
}

export class LivingMemoryIncrementalDreamService {
    private readonly unitProcessor: DreamUnitProcessor

    constructor(
        private readonly ctx: Context,
        private readonly config: IncrementalDreamConfig,
        private readonly repository: IncrementalDreamRepository,
        private readonly debug: (message: string) => void
    ) {
        this.unitProcessor = new DreamUnitProcessor(
            repository,
            debug,
            config.debug
        )
    }

    async run(
        presetId: string,
        batchSize: number
    ): Promise<IncrementalDreamRunResult> {
        const batch = await this.repository.listPendingEntries(
            presetId,
            batchSize
        )
        const state: IncrementalRunState = {
            stats: createEmptyStats(),
            firstRoundStats: createEmptyStats(),
            secondRoundStats: createEmptyStats(),
            clusterCount: 0,
            activeInputCount: batch.filter((entry) => entry.status === 'active')
                .length,
            archivedInputCount: batch.filter(
                (entry) => entry.status === 'archived'
            ).length,
            seedCount: 0,
            successfulSeedCount: 0,
            failedSeedCount: 0,
            noCandidateSeedCount: 0,
            errors: []
        }
        if (batch.length === 0) {
            return this.createResult(presetId, batch, state)
        }

        const model = await this.createChatModel()
        const retriever = await IncrementalDreamRetriever.create(
            this.ctx,
            this.config,
            this.repository,
            batch[0].content,
            this.debug
        )
        const assistantLabel = resolveAssistantLabel(presetId)
        const presetPrompt = await resolvePresetPrompt(this.ctx, presetId)

        for (const stage of ['active', 'archived'] as const) {
            const entries = batch.filter((entry) => entry.status === stage)
            if (entries.length === 0) {
                continue
            }
            state.clusterCount++
            const result = await this.unitProcessor.process({
                presetId,
                assistantLabel,
                presetPrompt,
                stage,
                cluster: {
                    id: `cluster-${stage}`,
                    reason: 'memory group',
                    entries
                },
                model,
                touchedMemoryIds: new Set(),
                consolidationMode: 'incremental-batch'
            })
            addStats(state.stats, result)
            addStats(state.firstRoundStats, result)
            if (result.success === false) {
                state.errors.push(`first-round ${stage}: ${result.error}`)
                return this.createResult(presetId, batch, state)
            }
        }

        const batchIds = new Set(batch.map((entry) => entry.id))
        const seeds = await this.loadSeeds(presetId, batch)
        state.seedCount = seeds.length
        const candidatePools = this.createCandidatePools(
            await this.repository.listConsolidatedEntries(presetId),
            batchIds
        )

        for (const seed of seeds) {
            const candidates = [...candidatePools[seed.status].values()]
            const nearest = await retriever.retrieve(seed, candidates)
            if (nearest.length === 0) {
                await this.repository.setMemoryConsolidation([seed.id], true)
                state.successfulSeedCount++
                state.noCandidateSeedCount++
                continue
            }

            state.clusterCount++
            const result = await this.unitProcessor.process({
                presetId,
                assistantLabel,
                presetPrompt,
                stage: seed.status,
                cluster: {
                    id: `cluster-${seed.id}`,
                    reason: 'memory group',
                    entries: [seed, ...nearest]
                },
                model,
                touchedMemoryIds: new Set(),
                consolidationMode: 'incremental-seed',
                focusMemoryId: seed.id
            })
            addStats(state.stats, result)
            addStats(state.secondRoundStats, result)
            await this.refreshCandidatePools(
                presetId,
                candidatePools,
                batchIds,
                result.mutatedMemoryIds
            )
            if (result.success === true) {
                state.successfulSeedCount++
            } else {
                state.failedSeedCount++
                state.errors.push(`seed ${seed.id}: ${result.error}`)
            }
        }

        return this.createResult(presetId, batch, state)
    }

    private async createChatModel(): Promise<ChatLunaChatModel> {
        if (!isModelConfigured(this.config.mainModel)) {
            throw new Error('incremental dream model is not configured')
        }
        const model = await this.ctx.chatluna.createChatModel(
            this.config.mainModel
        )
        if (model.value === undefined) {
            throw new Error('incremental dream model is unavailable')
        }
        return model.value
    }

    private async loadSeeds(presetId: string, batch: MemoryEntryRecord[]) {
        const entryById = new Map(
            (
                await this.repository.getEntriesByPresetAndIds(
                    presetId,
                    batch.map((entry) => entry.id)
                )
            ).map((entry) => [entry.id, entry])
        )
        return batch
            .map((entry) => entryById.get(entry.id))
            .filter(
                (entry): entry is MemoryEntryRecord =>
                    entry !== undefined && !entry.isConsolidated
            )
            .sort(
                (left, right) =>
                    stageOrder(left.status) - stageOrder(right.status) ||
                    +left.createdAt - +right.createdAt ||
                    left.id.localeCompare(right.id)
            )
    }

    private createCandidatePools(
        entries: MemoryEntryRecord[],
        batchIds: Set<string>
    ) {
        const pools: Record<DreamStage, Map<string, MemoryEntryRecord>> = {
            active: new Map(),
            archived: new Map()
        }
        for (const entry of entries) {
            if (!batchIds.has(entry.id)) {
                pools[entry.status].set(entry.id, entry)
            }
        }
        return pools
    }

    private async refreshCandidatePools(
        presetId: string,
        pools: Record<DreamStage, Map<string, MemoryEntryRecord>>,
        batchIds: Set<string>,
        mutatedMemoryIds: Set<string>
    ) {
        if (mutatedMemoryIds.size === 0) {
            return
        }
        const ids = [...mutatedMemoryIds]
        for (const id of ids) {
            pools.active.delete(id)
            pools.archived.delete(id)
        }
        const entries = await this.repository.getEntriesByPresetAndIds(
            presetId,
            ids
        )
        for (const entry of entries) {
            if (entry.isConsolidated && !batchIds.has(entry.id)) {
                pools[entry.status].set(entry.id, entry)
            }
        }
    }

    private async createResult(
        presetId: string,
        batch: MemoryEntryRecord[],
        state: IncrementalRunState
    ): Promise<IncrementalDreamRunResult> {
        const remainingPendingCount =
            await this.repository.countPendingEntries(presetId)
        const failed = state.errors.length > 0
        const statsDetail = [
            `kept ${state.stats.kept}`,
            `merged ${state.stats.merged}`,
            `updated ${state.stats.updated}`,
            `archived ${state.stats.archived}`,
            `deleted ${state.stats.deleted}`,
            `skipped ${state.stats.skipped}`
        ].join(', ')
        const firstRoundDetail = [
            `merged ${state.firstRoundStats.merged}`,
            `updated ${state.firstRoundStats.updated}`,
            `archived ${state.firstRoundStats.archived}`,
            `deleted ${state.firstRoundStats.deleted}`,
            `skipped ${state.firstRoundStats.skipped}`
        ].join(', ')
        const secondRoundDetail = [
            `kept ${state.secondRoundStats.kept}`,
            `merged ${state.secondRoundStats.merged}`,
            `updated ${state.secondRoundStats.updated}`,
            `archived ${state.secondRoundStats.archived}`,
            `deleted ${state.secondRoundStats.deleted}`,
            `skipped ${state.secondRoundStats.skipped}`
        ].join(', ')
        const detail = [
            `dream automatic incremental: selected ${batch.length}, active ${state.activeInputCount}, archived ${state.archivedInputCount}`,
            `first round: ${firstRoundDetail}`,
            `second round: seeds ${state.seedCount}, succeeded ${state.successfulSeedCount}, failed ${state.failedSeedCount}`,
            `second round: no candidates ${state.noCandidateSeedCount}, ${secondRoundDetail}`,
            `total: ${statsDetail}`,
            `remaining pending ${remainingPendingCount}`,
            ...state.errors.map((error) => `error: ${error}`)
        ].join('\n')

        return {
            entryCount: batch.length,
            clusterCount: state.clusterCount,
            ...state.stats,
            selectedCount: batch.length,
            seedCount: state.seedCount,
            successfulSeedCount: state.successfulSeedCount,
            failedSeedCount: state.failedSeedCount,
            remainingPendingCount,
            failed,
            detail
        }
    }
}

const stageOrder = (stage: DreamStage) => {
    if (stage === 'active') {
        return 0
    }
    return 1
}
