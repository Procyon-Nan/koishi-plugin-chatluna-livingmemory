import type { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { MemoryEntryRecord } from '../../../contracts/memory'
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
import { addStats, createEmptyStats, formatStageDetail } from './stats'
import type { DreamOperationStats, DreamRunResult, DreamStage } from './types'
import { DreamUnitProcessor } from './unit_processor'
import type { LivingMemoryLogger } from '../../logging/logger'
import { createSpeakerKeysSignature } from '../../memory/speaker_identity'

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
    stageStats: Record<DreamStage, DreamOperationStats>
    stageClusterCounts: Record<DreamStage, number>
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
            stageStats: {
                active: createEmptyStats(),
                archived: createEmptyStats()
            },
            stageClusterCounts: { active: 0, archived: 0 },
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
        const assistantLabel = resolveAssistantLabel(presetId)
        const presetPrompt = await resolvePresetPrompt(this.ctx, presetId)

        for (const stage of ['active', 'archived'] as const) {
            const groups = this.groupBySpeakerKeys(
                batch.filter((entry) => entry.status === stage)
            )
            for (const entries of groups) {
                state.clusterCount++
                state.stageClusterCounts[stage]++
                const result = await this.unitProcessor.process({
                    presetId,
                    assistantLabel,
                    presetPrompt,
                    stage,
                    cluster: {
                        id: `cluster-${stage}-${state.stageClusterCounts[stage]}`,
                        reason: 'memory group',
                        entries
                    },
                    model,
                    touchedMemoryIds: new Set(),
                    consolidationMode: 'incremental-batch',
                    logger
                })
                addStats(state.stats, result)
                addStats(state.firstRoundStats, result)
                addStats(state.stageStats[stage], result)
                if (result.success === false) {
                    state.errors.push(`first-round ${stage}: ${result.error}`)
                    return this.createResult(presetId, batch, state)
                }
            }
        }

        const batchIds = batch.map((entry) => entry.id)
        const seeds = await this.loadSeeds(presetId, batch)
        state.seedCount = seeds.length

        for (const seed of seeds) {
            const nearestIds =
                await this.neighborSearch.findConsolidatedNeighbors({
                    presetId,
                    seedMemoryId: seed.id,
                    status: seed.status,
                    excludedMemoryIds: batchIds,
                    limit: INCREMENTAL_DREAM_TOP_K
                })
            const speakerSignature = createSpeakerKeysSignature(
                seed.speakerKeys
            )
            const nearest = (
                await this.loadNeighbors(presetId, nearestIds)
            ).filter(
                (entry) =>
                    createSpeakerKeysSignature(entry.speakerKeys) ===
                    speakerSignature
            )
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
            state.stageClusterCounts[seed.status]++
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
                focusMemoryId: seed.id,
                logger
            })
            addStats(state.stats, result)
            addStats(state.secondRoundStats, result)
            addStats(state.stageStats[seed.status], result)
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

    private groupBySpeakerKeys(entries: MemoryEntryRecord[]) {
        const groups = new Map<string, MemoryEntryRecord[]>()
        for (const entry of entries) {
            const key = createSpeakerKeysSignature(entry.speakerKeys)
            const group = groups.get(key) ?? []
            group.push(entry)
            groups.set(key, group)
        }
        return [...groups.values()]
    }

    private async loadNeighbors(presetId: string, memoryIds: string[]) {
        const entries = await this.repository.getEntriesByPresetAndIds(
            presetId,
            memoryIds
        )
        const entryById = new Map(entries.map((entry) => [entry.id, entry]))
        return memoryIds.map((memoryId) => {
            const entry = entryById.get(memoryId)
            if (entry === undefined) {
                throw new Error(
                    `incremental dream neighbor is missing: ` +
                        `preset=${presetId}, memory=${memoryId}`
                )
            }
            return entry
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
        const stageResults = (['active', 'archived'] as const).map((stage) => {
            const entryCount =
                stage === 'active'
                    ? state.activeInputCount
                    : state.archivedInputCount
            const clusterCount = state.stageClusterCounts[stage]
            const stats = state.stageStats[stage]
            return {
                stage,
                entryCount,
                clusterCount,
                ...stats,
                detail: formatStageDetail(
                    stage,
                    entryCount,
                    clusterCount,
                    stats
                )
            }
        })

        return {
            entryCount: batch.length,
            clusterCount: state.clusterCount,
            stageResults,
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
