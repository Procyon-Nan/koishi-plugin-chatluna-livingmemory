import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { ManualDreamVectorReader } from '../../../contracts/vector_index'
import type {
    DreamMemoryEntryRecord,
    LivingMemoryConfig,
    LivingMemoryUpdateProvider
} from '../../../contracts/workflows'
import type { PresetPersonaResolver } from '../../../contracts/memory'
import type { LivingMemoryMutationService } from '../../app/memory_mutation_service'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import { resolveAssistantLabel } from '../../memory/helpers'
import { DreamClusterer } from './clustering'
import type { DreamWorkerRunner } from './worker/protocol'
import type { LivingMemoryUserProfileService } from '../../user_profile'
import type { DreamRunResult } from './types'
import type { LivingMemoryLogger } from '../../logging/logger'
import { createDreamSessionState, getDreamCoverage } from './session/state'
import { createDreamSessionTools } from './session/tools'
import { runDreamSession } from './session/runner'

export interface DreamRepository extends Pick<
    LivingMemoryUpdateProvider,
    'listPresetSpeakers'
> {
    listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]>
    listActiveMemorySpeakerKeys(presetId: string): Promise<string[]>
}

export class LivingMemoryDreamService {
    private readonly clusterer: DreamClusterer

    constructor(
        private readonly ctx: Context,
        private readonly config: Pick<LivingMemoryConfig, 'mainModel'>,
        private readonly repository: DreamRepository,
        private readonly mutations: Pick<
            LivingMemoryMutationService,
            | 'ensurePresetSpeakersCoverage'
            | 'updateActiveMemory'
            | 'mergeActiveMemories'
            | 'splitActiveMemory'
            | 'archiveActiveMemories'
            | 'setMemoryConsolidation'
        >,
        vectors: ManualDreamVectorReader,
        worker: DreamWorkerRunner,
        private readonly userProfiles: LivingMemoryUserProfileService,
        private readonly presetPersona: PresetPersonaResolver
    ) {
        this.clusterer = new DreamClusterer(vectors, worker)
    }

    async run(
        presetId: string,
        sessionId: string,
        logger: LivingMemoryLogger,
        signal?: AbortSignal
    ): Promise<DreamRunResult> {
        signal?.throwIfAborted()
        const entries = await this.repository.listDreamEntriesByPreset(presetId)
        const state = createDreamSessionState(entries.map((entry) => entry.id))
        let error: string | undefined
        let profileDetail = ''
        try {
            signal?.throwIfAborted()
            if (!isModelConfigured(this.config.mainModel)) {
                throw new Error('Dream mainModel 未配置。')
            }
            const model = (
                await this.ctx.chatluna.createChatModel(this.config.mainModel)
            ).value
            if (model === undefined) throw new Error('Dream mainModel 不可用。')
            const presetPrompt =
                await this.presetPersona.resolveOrGenerateCardText(presetId)
            signal?.throwIfAborted()
            const speakers =
                await this.mutations.ensurePresetSpeakersCoverage(presetId)
            state.clusters = await this.clusterer.buildClusters(
                presetId,
                entries,
                logger
            )
            signal?.throwIfAborted()
            const tools = createDreamSessionTools({
                presetId,
                state,
                speakers: this.repository,
                mutations: this.mutations
            })
            await runDreamSession({
                presetId,
                sessionId,
                assistantLabel: resolveAssistantLabel(presetId),
                presetPrompt,
                speakers,
                state,
                tools,
                model,
                logger,
                signal
            })
            signal?.throwIfAborted()
            profileDetail = await this.regenerateUserProfilesAfterDream(
                presetId,
                model,
                logger,
                signal
            )
            signal?.throwIfAborted()
        } catch (cause) {
            error = summarizeError(cause)
        }
        const coverage = getDreamCoverage(state)
        const status =
            error !== undefined || coverage.processedCount === 0
                ? 'failed'
                : coverage.unprocessedMemoryIds.length > 0
                  ? 'partial'
                  : 'completed'
        const detail = [
            `dream: ${status}, processed ${coverage.processedCount}/${coverage.targetCount}, batches ${state.clusters.length}`,
            `checked ${state.stats.kept}, merged ${state.stats.merged}, split ${state.stats.split}, updated ${state.stats.updated}, archived ${state.stats.archived}`,
            ...state.skippedBatches.map(
                (batch) =>
                    `skipped ${batch.batchId}: ${batch.reason}; memoryIds=${batch.memoryIds.join(', ')}`
            ),
            `unprocessed: ${coverage.unprocessedMemoryIds.join(', ') || 'none'}`,
            error === undefined ? '' : `error: ${error}`,
            profileDetail
        ]
            .filter(Boolean)
            .join('\n')
        return {
            status,
            entryCount: coverage.targetCount,
            clusterCount: state.clusters.length,
            processedCount: coverage.processedCount,
            unprocessedMemoryIds: coverage.unprocessedMemoryIds,
            skippedBatches: state.skippedBatches,
            ...state.stats,
            error,
            detail
        }
    }

    private async regenerateUserProfilesAfterDream(
        presetId: string,
        model: ChatLunaChatModel,
        logger: LivingMemoryLogger,
        signal?: AbortSignal
    ) {
        try {
            // 画像阶段不会执行时无需查询候选用户；此时 regenerate 在读取
            // speakerKeys 之前即返回 disabled，由它统一给出跳过说明。
            const speakerKeys = this.userProfiles.enabled
                ? await this.repository.listActiveMemorySpeakerKeys(presetId)
                : []
            const result = await this.userProfiles.regenerate(
                presetId,
                speakerKeys,
                model,
                logger,
                signal
            )
            return result.detail
        } catch (error) {
            signal?.throwIfAborted()
            const errorSummary = summarizeError(error)
            const errorMessage =
                error instanceof Error ? error.message : errorSummary
            const detail = `user profiles failed: ${errorMessage}`
            logger.diagnostic('dream.user-profile.failed', {
                error: errorSummary
            })
            return detail
        }
    }
}
