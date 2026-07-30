import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { MemoryEntryRecord } from '../../../contracts/memory'
import type {
    LivingMemoryConfig,
    RecallRepository,
    UserProfileRepository
} from '../../../contracts/workflows'
import type { EmbeddingRepositoryLike } from '../../shared/embeddings'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import {
    resolveAssistantLabel,
    resolvePresetPrompt
} from '../../memory/helpers'
import { DreamClusterer } from './clustering'
import { DreamExecutor, type DreamExecutorRepository } from './executor'
import { LivingMemoryUserProfileService } from '../../user_profile'
import {
    buildDreamPrompt,
    dreamActiveResultSchema,
    dreamArchivedResultSchema,
    dreamResultToolDescription,
    dreamResultToolName
} from '../../prompts'
import { formatPromptMessagesTrace } from '../../prompts/prompt_format'
import {
    addStats,
    createEmptyStageResult,
    createEmptyStats,
    formatStageDetail,
    sumStats
} from './stats'
import type { DreamRunResult, DreamStage, DreamStageResult } from './types'
import {
    invokeStructuredOutput,
    isStructuredOutputModelInvocationError
} from '../structured_output'

export type { DreamRunResult } from './types'

type LivingMemoryDreamConfig = Pick<
    LivingMemoryConfig,
    | 'dreamModel'
    | 'embeddingModel'
    | 'enableUserProfileInjection'
    | 'userProfileMemoryLimit'
>

export type DreamRepository = Pick<RecallRepository, 'listEntriesByPreset'> &
    EmbeddingRepositoryLike &
    DreamExecutorRepository &
    UserProfileRepository

export class LivingMemoryDreamService {
    private readonly clusterer: DreamClusterer
    private readonly executor: DreamExecutor
    private readonly userProfiles: LivingMemoryUserProfileService

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryDreamConfig,
        private readonly repository: DreamRepository,
        private readonly debug: (message: string) => void
    ) {
        this.clusterer = new DreamClusterer(ctx, config, repository, debug)
        this.executor = new DreamExecutor(repository)
        this.userProfiles = new LivingMemoryUserProfileService(
            ctx,
            config,
            repository,
            debug
        )
    }

    async run(presetId: string): Promise<DreamRunResult> {
        const entries = await this.repository.listEntriesByPreset(presetId)
        if (entries.length < 2) {
            return this.createResult(entries.length, 0, {
                detail: `dream skipped: only ${entries.length} memories`
            })
        }

        const activeEntries = entries.filter(
            (entry) => entry.status === 'active'
        )

        if (!isModelConfigured(this.config.dreamModel)) {
            return this.createResult(entries.length, 0, {
                skippedReason: 'model-not-configured',
                detail: 'dream skipped: model-not-configured'
            })
        }

        const model = await this.ctx.chatluna.createChatModel(
            this.config.dreamModel
        )
        if (model.value == null) {
            return this.createResult(entries.length, 0, {
                skippedReason: 'model-unavailable',
                detail: 'dream skipped: model-unavailable'
            })
        }

        const chatModel = model.value
        const assistantLabel = resolveAssistantLabel(presetId)
        let presetPrompt = ''
        try {
            presetPrompt = await resolvePresetPrompt(this.ctx, presetId)
        } catch (error) {
            this.debug(
                [
                    `memory dream preset prompt unavailable: presetId=${presetId}`,
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
        }
        const activeResult = await this.runStage(
            presetId,
            assistantLabel,
            presetPrompt,
            'active',
            activeEntries,
            chatModel
        )
        const refreshedEntries =
            await this.repository.listEntriesByPreset(presetId)
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
                await this.repository.listEntriesByPreset(presetId)
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
        entries: MemoryEntryRecord[],
        model: ChatLunaChatModel
    ): Promise<DreamStageResult> {
        if (entries.length < 2) {
            return createEmptyStageResult(stage, entries.length)
        }

        const clusters = await this.clusterer.buildClusters(entries)
        this.debug(
            [
                `memory dream clusters: presetId=${presetId}`,
                `stage=${stage}`,
                `entryCount=${entries.length}`,
                `clusterCount=${clusters.length}`,
                clusters
                    .map(
                        (cluster) =>
                            `${cluster.id} reason=${cluster.reason} ids=${cluster.entries
                                .map((entry) => entry.id)
                                .join(',')}`
                    )
                    .join('\n')
            ].join('\n')
        )

        const touchedMemoryIds = new Set<string>()
        const stats = createEmptyStats()

        for (const cluster of clusters) {
            const prompt = buildDreamPrompt({
                assistantLabel,
                presetPrompt,
                presetId,
                cluster,
                stage
            })
            this.debug(
                [
                    `memory dream llm input: presetId=${presetId}`,
                    `stage=${stage}`,
                    `clusterId=${cluster.id}`,
                    formatPromptMessagesTrace(prompt)
                ].join('\n')
            )

            let structuredResult
            try {
                structuredResult = await invokeStructuredOutput({
                    model,
                    prompt,
                    toolName: dreamResultToolName,
                    toolDescription: dreamResultToolDescription,
                    stringifiedArrayField: 'operations',
                    schema:
                        stage === 'active'
                            ? dreamActiveResultSchema
                            : dreamArchivedResultSchema,
                    context: {
                        presetId,
                        conversationId: [
                            'dream',
                            presetId,
                            stage,
                            cluster.id
                        ].join(':')
                    }
                })
            } catch (error) {
                if (!isStructuredOutputModelInvocationError(error)) {
                    throw error
                }

                stats.skipped++
                this.debug(
                    [
                        `memory dream cluster skipped: presetId=${presetId}`,
                        `stage=${stage}`,
                        `clusterId=${cluster.id}`,
                        'reason=invoke-failed',
                        `error=${summarizeError(error)}`
                    ].join(' ')
                )
                continue
            }

            this.debug(
                [
                    `memory dream llm output: presetId=${presetId}`,
                    `stage=${stage}`,
                    `clusterId=${cluster.id}`,
                    structuredResult.output
                ].join('\n')
            )

            if (structuredResult.parseError != null) {
                this.debug(
                    [
                        `memory dream structured output failed: presetId=${presetId}`,
                        `stage=${stage}`,
                        `clusterId=${cluster.id}`,
                        `error=${structuredResult.parseError}`
                    ].join(' ')
                )
                throw new Error(
                    `dream structured output failed: ${structuredResult.parseError}`
                )
            }

            const operations = structuredResult.value?.operations ?? []
            if (operations.length === 0) {
                stats.skipped++
                this.debug(
                    [
                        `memory dream cluster skipped: presetId=${presetId}`,
                        `stage=${stage}`,
                        `clusterId=${cluster.id}`,
                        'reason=no-valid-operations'
                    ].join(' ')
                )
                continue
            }

            const result = await this.executor.executeOperations(
                stage,
                cluster,
                operations,
                touchedMemoryIds
            )
            addStats(stats, result)
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
}
