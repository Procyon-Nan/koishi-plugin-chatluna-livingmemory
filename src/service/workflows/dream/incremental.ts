import type { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    MemoryEntryRecord,
    PresetSpeakerRecord
} from '../../../contracts/memory'
import type { IncrementalDreamNeighborSearch } from '../../../contracts/vector_index'
import type {
    DreamMemoryRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import {
    resolveAssistantLabel,
    resolvePresetPrompt
} from '../../memory/helpers'
import { isModelConfigured } from '../../shared/utils'
import { addStats, createEmptyStats } from './stats'
import type { DreamOperationStats, DreamRunResult } from './types'
import { DreamUnitProcessor } from './unit_processor'
import type { LivingMemoryLogger } from '../../logging/logger'

type IncrementalDreamConfig = Pick<LivingMemoryConfig, 'mainModel' | 'debug'>

export interface IncrementalDreamRepository {
    listPendingEntries(
        presetId: string,
        limit: number
    ): Promise<MemoryEntryRecord[]>
    getEntriesByPresetAndIds(
        presetId: string,
        ids: string[]
    ): Promise<MemoryEntryRecord[]>
    countPendingEntries(presetId: string): Promise<number>
    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]>
}

const INCREMENTAL_DREAM_TOP_K = 30

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
        private readonly mutations: DreamMemoryRepository,
        private readonly neighborSearch: IncrementalDreamNeighborSearch
    ) {
        this.unitProcessor = new DreamUnitProcessor(mutations)
    }

    async run(
        presetId: string,
        batchSize: number,
        logger?: LivingMemoryLogger
    ): Promise<IncrementalDreamRunResult> {
        this.neighborSearch.assertPresetReady(presetId)
        const batch = await this.repository.listPendingEntries(
            presetId,
            batchSize
        )
        const state: IncrementalRunState = {
            stats: createEmptyStats(),
            firstRoundStats: createEmptyStats(),
            secondRoundStats: createEmptyStats(),
            clusterCount: 0,
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
        const assistantLabel = resolveAssistantLabel(presetId)
        const presetPrompt = await resolvePresetPrompt(this.ctx, presetId)
        const speakers = await this.repository.listPresetSpeakers(presetId)

        state.clusterCount++
        const firstRoundResult = await this.unitProcessor.process({
            presetId,
            assistantLabel,
            presetPrompt,
            cluster: {
                id: 'cluster-active',
                reason: 'memory group',
                entries: batch
            },
            speakers,
            model,
            touchedMemoryIds: new Set(),
            consolidationMode: 'incremental-batch',
            logger
        })
        addStats(state.stats, firstRoundResult)
        addStats(state.firstRoundStats, firstRoundResult)
        if (firstRoundResult.success === false) {
            state.errors.push(`first-round: ${firstRoundResult.error}`)
            return this.createResult(presetId, batch, state)
        }

        const batchIds = batch.map((entry) => entry.id)
        const seeds = await this.loadSeeds(presetId, batch)
        state.seedCount = seeds.length

        for (const seed of seeds) {
            const nearestIds =
                await this.neighborSearch.findConsolidatedNeighbors({
                    presetId,
                    seedMemoryId: seed.id,
                    excludedMemoryIds: batchIds,
                    limit: INCREMENTAL_DREAM_TOP_K
                })
            const nearest = await this.loadNeighbors(presetId, nearestIds)
            if (nearest.length === 0) {
                await this.mutations.setMemoryConsolidation(
                    presetId,
                    [seed.id],
                    true
                )
                state.successfulSeedCount++
                state.noCandidateSeedCount++
                continue
            }

            state.clusterCount++
            const result = await this.unitProcessor.process({
                presetId,
                assistantLabel,
                presetPrompt,
                cluster: {
                    id: `cluster-${seed.id}`,
                    reason: 'memory group',
                    entries: [seed, ...nearest]
                },
                speakers,
                model,
                touchedMemoryIds: new Set(),
                consolidationMode: 'incremental-seed',
                focusMemoryId: seed.id,
                logger
            })
            addStats(state.stats, result)
            addStats(state.secondRoundStats, result)
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
                    entry !== undefined &&
                    entry.status === 'active' &&
                    !entry.isConsolidated
            )
            .sort(
                (left, right) =>
                    +left.createdAt - +right.createdAt ||
                    left.id.localeCompare(right.id)
            )
    }

    private async loadNeighbors(presetId: string, memoryIds: string[]) {
        const entries = await this.repository.getEntriesByPresetAndIds(
            presetId,
            memoryIds
        )
        const entryById = new Map(entries.map((entry) => [entry.id, entry]))
        return memoryIds.flatMap((memoryId) => {
            const entry = entryById.get(memoryId)
            if (entry === undefined) {
                throw new Error(
                    `incremental dream neighbor is missing: ` +
                        `preset=${presetId}, memory=${memoryId}`
                )
            }
            return entry.status === 'active' ? [entry] : []
        })
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
            `skipped ${state.stats.skipped}`
        ].join(', ')
        const firstRoundDetail = [
            `merged ${state.firstRoundStats.merged}`,
            `updated ${state.firstRoundStats.updated}`,
            `archived ${state.firstRoundStats.archived}`,
            `skipped ${state.firstRoundStats.skipped}`
        ].join(', ')
        const secondRoundDetail = [
            `kept ${state.secondRoundStats.kept}`,
            `merged ${state.secondRoundStats.merged}`,
            `updated ${state.secondRoundStats.updated}`,
            `archived ${state.secondRoundStats.archived}`,
            `skipped ${state.secondRoundStats.skipped}`
        ].join(', ')
        const detail = [
            `dream automatic incremental: selected ${batch.length} active memories`,
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
