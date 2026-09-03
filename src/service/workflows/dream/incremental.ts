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
import { isModelConfigured, summarizeError } from '../../shared/utils'
import { addStats, createEmptyStats } from './stats'
import type { DreamOperationStats, DreamRunResult } from './types'
import { type DreamUnitInput, DreamUnitProcessor } from './unit_processor'
import type { LivingMemoryLogger } from '../../logging/logger'
import type { LivingMemoryUserProfileService } from '../../user_profile'

type IncrementalDreamConfig = Pick<LivingMemoryConfig, 'mainModel'>

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

const addSpeakerKeys = (
    target: Set<string>,
    entries: Pick<MemoryEntryRecord, 'speakerKeys'>[]
) => {
    for (const entry of entries) {
        for (const speakerKey of entry.speakerKeys) {
            target.add(speakerKey)
        }
    }
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
        private readonly neighborSearch: IncrementalDreamNeighborSearch,
        private readonly userProfiles: LivingMemoryUserProfileService
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
        const affectedSpeakerKeys = new Set<string>()

        let result: IncrementalDreamRunResult
        try {
            state.clusterCount++
            const firstRoundResult = await this.processUnit(
                {
                    presetId,
                    assistantLabel,
                    presetPrompt,
                    cluster: {
                        id: 'cluster-batch',
                        reason: 'memory group',
                        entries: batch
                    },
                    speakers,
                    model,
                    touchedMemoryIds: new Set(),
                    consolidationMode: 'incremental-batch',
                    logger
                },
                affectedSpeakerKeys
            )
            addStats(state.stats, firstRoundResult)
            addStats(state.firstRoundStats, firstRoundResult)
            if (firstRoundResult.success === false) {
                state.errors.push(`first-round: ${firstRoundResult.error}`)
            } else {
                // batch 是本轮新抽取的记忆，首轮成功即意味着这些用户有新记忆
                // 需要纳入画像，与模型是否产生合并/更新操作无关，因此这里不看
                // mutatedMemoryIds——此时它可能为空。
                addSpeakerKeys(affectedSpeakerKeys, batch)
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
                    const nearest = await this.loadNeighbors(
                        presetId,
                        nearestIds
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
                    const clusterEntries = [seed, ...nearest]
                    const seedResult = await this.processUnit(
                        {
                            presetId,
                            assistantLabel,
                            presetPrompt,
                            cluster: {
                                id: `cluster-${seed.id}`,
                                reason: 'memory group',
                                entries: clusterEntries
                            },
                            speakers,
                            model,
                            touchedMemoryIds: new Set(),
                            consolidationMode: 'incremental-seed',
                            focusMemoryId: seed.id,
                            logger
                        },
                        affectedSpeakerKeys
                    )
                    addStats(state.stats, seedResult)
                    addStats(state.secondRoundStats, seedResult)
                    if (seedResult.success === true) {
                        state.successfulSeedCount++
                    } else {
                        state.failedSeedCount++
                        state.errors.push(
                            `seed ${seed.id}: ${seedResult.error}`
                        )
                    }
                }
            }
            result = await this.createResult(presetId, batch, state)
        } catch (error) {
            await this.regenerateUserProfiles(
                presetId,
                model,
                affectedSpeakerKeys,
                logger
            )
            throw error
        }

        const profileDetail = await this.regenerateUserProfiles(
            presetId,
            model,
            affectedSpeakerKeys,
            logger
        )
        return profileDetail == null
            ? result
            : { ...result, detail: `${result.detail}\n${profileDetail}` }
    }

    private async processUnit(
        input: DreamUnitInput,
        affectedSpeakerKeys: Set<string>
    ) {
        try {
            const result = await this.unitProcessor.process(input)
            addSpeakerKeys(
                affectedSpeakerKeys,
                input.cluster.entries.filter((entry) =>
                    result.mutatedMemoryIds.has(entry.id)
                )
            )
            return result
        } catch (error) {
            addSpeakerKeys(affectedSpeakerKeys, input.cluster.entries)
            throw error
        }
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

    private async regenerateUserProfiles(
        presetId: string,
        model: ChatLunaChatModel,
        speakerKeys: Set<string>,
        logger?: LivingMemoryLogger
    ) {
        if (speakerKeys.size === 0) {
            return null
        }

        try {
            return (
                await this.userProfiles.regenerate(
                    presetId,
                    [...speakerKeys],
                    model,
                    logger
                )
            ).detail
        } catch (error) {
            const errorSummary = summarizeError(error)
            const detail = `user profiles failed: ${
                error instanceof Error ? error.message : errorSummary
            }`
            logger?.diagnostic('dream.user-profile.failed', {
                error: errorSummary
            })
            return detail
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
            `dream automatic incremental: selected ${batch.length} memories`,
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
