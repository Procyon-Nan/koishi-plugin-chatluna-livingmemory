import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { DreamVectorProvider } from '../../../contracts/vector_index'
import type {
    DreamMemoryEntryRecord,
    LivingMemoryConfig,
    LivingMemoryUpdateProvider
} from '../../../contracts/workflows'
import type { PresetPersonaResolver } from '../../../contracts/memory'
import type { LivingMemoryMutationService } from '../../app/memory_mutation_service'
import { isModelConfigured, formatErrorDetails } from '../../shared/utils'
import { SerialTaskQueue } from '../../shared/serial_task_queue'
import { resolveAssistantLabel } from '../../memory/helpers'
import { DreamClusterer } from './clustering'
import type { DreamWorkerRunner } from './worker/protocol'
import type { LivingMemoryUserProfileService } from '../../user_profile'
import type { DreamRunResult } from './types'
import type { LivingMemoryLogger } from '../../logging/logger'
import {
    createDreamSessionState,
    getDreamCoverage,
    type DreamSessionState
} from './session/state'
import { createDreamSessionTools } from './session/tools'
import { createDreamCallOptions, runDreamSession } from './session/runner'

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
    private readonly planningQueue = new SerialTaskQueue()

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
        vectors: DreamVectorProvider,
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
        let state!: DreamSessionState
        let error: string | undefined
        let profileDetail = ''
        try {
            const { model, callOptions } = await this.planningQueue.run(
                'dream-planning',
                async () => {
                    signal?.throwIfAborted()
                    const entries =
                        await this.repository.listDreamEntriesByPreset(presetId)
                    state = createDreamSessionState(
                        entries.map((entry) => entry.id)
                    )
                    signal?.throwIfAborted()
                    if (!isModelConfigured(this.config.mainModel)) {
                        throw new Error('Dream mainModel 未配置。')
                    }
                    const model = (
                        await this.ctx.chatluna.createChatModel(
                            this.config.mainModel
                        )
                    ).value
                    if (model === undefined)
                        throw new Error('Dream mainModel 不可用。')
                    const callOptions = createDreamCallOptions(model, sessionId)
                    state.clusters = await this.clusterer.buildClusters(
                        presetId,
                        entries,
                        logger,
                        signal
                    )
                    return { model, callOptions }
                }
            )
            signal?.throwIfAborted()
            const presetPrompt =
                await this.presetPersona.resolveOrGenerateCardText(presetId)
            signal?.throwIfAborted()
            const speakers =
                await this.mutations.ensurePresetSpeakersCoverage(presetId)
            signal?.throwIfAborted()
            const tools = createDreamSessionTools({
                presetId,
                state,
                speakers: this.repository,
                mutations: this.mutations
            })
            await runDreamSession({
                presetId,
                callOptions,
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
            // 捕获目标之前的失败交由任务入口记录，之后的失败保留覆盖明细。
            if (state === undefined) throw cause
            error = formatErrorDetails(cause)
        }
        const coverage = getDreamCoverage(state)
        let status: DreamRunResult['status'] = 'completed'
        if (error !== undefined || coverage.processedCount === 0) {
            status = 'failed'
        } else if (coverage.unprocessedMemoryIds.length > 0) {
            status = 'partial'
        }
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
            skipped: state.skippedBatches.length,
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
        const startedAt = performance.now()
        logger.diagnostic('dream.user-profile.started')
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
            logger.diagnostic('dream.user-profile.completed', {
                ...result,
                elapsedMs: performance.now() - startedAt
            })
            return result.detail
        } catch (error) {
            signal?.throwIfAborted()
            logger.warn(
                'dream.user-profile.failed',
                {
                    elapsedMs: performance.now() - startedAt
                },
                error
            )
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : formatErrorDetails(error)
            return `user profiles failed: ${errorMessage}`
        }
    }
}
