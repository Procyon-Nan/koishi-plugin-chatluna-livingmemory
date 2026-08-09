import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { ManualDreamVectorReader } from '../../../contracts/vector_index'
import type {
    DreamMemoryEntryRecord,
    DreamMemoryRepository,
    LivingMemoryConfig,
    UserProfileRepository
} from '../../../contracts/workflows'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import {
    resolveAssistantLabel,
    resolvePresetPrompt
} from '../../memory/helpers'
import { DreamClusterer } from './clustering'
import type { DreamHdbscanRunner } from './hdbscan/protocol'
import { LivingMemoryUserProfileService } from '../../user_profile'
import {
    addStats,
    createEmptyStageResult,
    createEmptyStats,
    formatStageDetail,
    sumStats
} from './stats'
import type { DreamRunResult, DreamStage, DreamStageResult } from './types'
import { DreamUnitProcessor } from './unit_processor'

export type { DreamRunResult } from './types'

type LivingMemoryDreamConfig = Pick<
    LivingMemoryConfig,
    | 'mainModel'
    | 'debug'
    | 'enableUserProfileInjection'
    | 'userProfileMemoryLimit'
>

export interface DreamRepository extends UserProfileRepository {
    listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]>
}

export class LivingMemoryDreamService {
    private readonly clusterer: DreamClusterer
    private readonly unitProcessor: DreamUnitProcessor
    private readonly userProfiles: LivingMemoryUserProfileService

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryDreamConfig,
        private readonly repository: DreamRepository,
        private readonly mutations: DreamMemoryRepository,
        vectors: ManualDreamVectorReader,
        hdbscan: DreamHdbscanRunner,
        private readonly debug: (message: string) => void
    ) {
        this.clusterer = new DreamClusterer(
            vectors,
            debug,
            config.debug,
            hdbscan
        )
        this.unitProcessor = new DreamUnitProcessor(
            mutations,
            debug,
            config.debug
        )
        this.userProfiles = new LivingMemoryUserProfileService(
            ctx,
            config,
            repository,
            debug
        )
    }

    async run(presetId: string): Promise<DreamRunResult> {
        const entries = await this.repository.listDreamEntriesByPreset(presetId)
        if (entries.length < 2) {
            if (entries.length === 1) {
                await this.mutations.setMemoryConsolidation(
                    presetId,
                    [entries[0].id],
                    true
                )
            }
            return this.createResult(entries.length, 0, {
                detail: `dream skipped: only ${entries.length} memories`
            })
        }

        const activeEntries = entries.filter(
            (entry) => entry.status === 'active'
        )

        if (!isModelConfigured(this.config.mainModel)) {
            return this.createResult(entries.length, 0, {
                skippedReason: 'model-not-configured',
                detail: 'dream skipped: model-not-configured'
            })
        }

        const model = await this.ctx.chatluna.createChatModel(
            this.config.mainModel
        )
        if (model.value === undefined) {
            return this.createResult(entries.length, 0, {
                skippedReason: 'model-unavailable',
                detail: 'dream skipped: model-unavailable'
            })
        }

        const chatModel = model.value
        const assistantLabel = resolveAssistantLabel(presetId)
        const presetPrompt = await resolvePresetPrompt(this.ctx, presetId)
        const activeResult = await this.runStage(
            presetId,
            assistantLabel,
            presetPrompt,
            'active',
            activeEntries,
            chatModel
        )
        const refreshedEntries =
            await this.repository.listDreamEntriesByPreset(presetId)
        const archivedEntries = refreshedEntries.filter(
            (entry) => entry.status === 'archived'
        )
        const archivedResult = await this.runStage(
            presetId,
            assistantLabel,
            presetPrompt,
            'archived',
            archivedEntries,
            chatModel
        )
        const profileDetail = await this.regenerateUserProfilesAfterDream(
            presetId,
            chatModel
        )
        const stats = sumStats([activeResult, archivedResult])
        const detail = [
            activeResult.detail,
            archivedResult.detail,
            profileDetail
        ].join('\n')

        this.debug(
            [
                `memory dream execution summary: presetId=${presetId}`,
                detail
            ].join('\n')
        )

        return {
            entryCount: entries.length,
            clusterCount:
                activeResult.clusterCount + archivedResult.clusterCount,
            ...stats,
            detail
        }
    }

    private async regenerateUserProfilesAfterDream(
        presetId: string,
        model: ChatLunaChatModel
    ) {
        if (!this.config.enableUserProfileInjection) {
            return 'user profiles skipped: disabled'
        }

        try {
            const finalEntries =
                await this.repository.listDreamEntriesByPreset(presetId)
            const result = await this.userProfiles.regenerate(
                presetId,
                finalEntries.filter((entry) => entry.status === 'active'),
                model
            )
            return result.detail
        } catch (error) {
            const errorSummary = summarizeError(error)
            const errorMessage =
                error instanceof Error ? error.message : errorSummary
            const detail = `user profiles failed: ${errorMessage}`
            this.debug(
                [
                    `memory user profile generation failed after dream: presetId=${presetId}`,
                    `error=${errorSummary}`
                ].join(' ')
            )
            return detail
        }
    }

    private async runStage(
        presetId: string,
        assistantLabel: string,
        presetPrompt: string,
        stage: DreamStage,
        entries: DreamMemoryEntryRecord[],
        model: ChatLunaChatModel
    ): Promise<DreamStageResult> {
        this.trace(
            () =>
                `memory dream stage started: presetId=${presetId} ` +
                `stage=${stage} entries=${entries.length}`
        )
        if (entries.length < 2) {
            if (entries.length === 1) {
                await this.mutations.setMemoryConsolidation(
                    presetId,
                    [entries[0].id],
                    true
                )
            }
            return createEmptyStageResult(stage, entries.length)
        }

        const clusters = await this.clusterer.buildClusters(
            presetId,
            stage,
            entries
        )

        const stats = createEmptyStats()
        const touchedMemoryIds = new Set<string>()

        for (const cluster of clusters) {
            const result = await this.unitProcessor.process({
                assistantLabel,
                presetPrompt,
                presetId,
                cluster,
                stage,
                model,
                touchedMemoryIds,
                consolidationMode: 'manual'
            })
            addStats(stats, result)
            if (result.success === false) {
                if (result.skipped === 0) {
                    stats.skipped++
                }
                this.debug(
                    [
                        `memory dream cluster skipped: presetId=${presetId}`,
                        `stage=${stage}`,
                        `clusterId=${cluster.id}`,
                        `reason=${result.error}`
                    ].join(' ')
                )
            }
        }

        return {
            stage,
            entryCount: entries.length,
            clusterCount: clusters.length,
            ...stats,
            detail: formatStageDetail(
                stage,
                entries.length,
                clusters.length,
                stats
            )
        }
    }

    private createResult(
        entryCount: number,
        clusterCount: number,
        options: {
            detail: string
            skippedReason?: string
        }
    ): DreamRunResult {
        return {
            entryCount,
            clusterCount,
            kept: 0,
            merged: 0,
            updated: 0,
            archived: 0,
            deleted: 0,
            skipped: 0,
            skippedReason: options.skippedReason,
            detail: options.detail
        }
    }

    private trace(buildMessage: () => string) {
        if (this.config.debug) {
            this.debug(buildMessage())
        }
    }
}
