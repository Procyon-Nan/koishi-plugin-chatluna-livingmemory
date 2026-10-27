import type { LivingMemoryRepository } from '../../persistence/repository'
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
import {
    buildIncrementalDreamBatches,
    refreshIncrementalDreamBatch
} from './incremental'
import type { LivingMemorySearchEngine } from '../recall/memory_search_engine'
import type { DreamRunInput, DreamRunResult } from './types'
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
    getEntriesByPresetAndIds: LivingMemoryRepository['getEntriesByPresetAndIds']
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
        >,
        vectors: DreamVectorProvider,
        worker: DreamWorkerRunner,
        private readonly userProfiles: LivingMemoryUserProfileService,
        private readonly presetPersona: PresetPersonaResolver,
        private readonly search: Pick<
            LivingMemorySearchEngine,
            'searchMemoriesDetailed'
        >
    ) {
        this.clusterer = new DreamClusterer(vectors, worker)
    }

    async run(
        presetId: string,
        sessionId: string,
        logger: LivingMemoryLogger,
        signal?: AbortSignal,
        input: DreamRunInput = { mode: 'full' }
    ): Promise<DreamRunResult> {
        signal?.throwIfAborted()
        let state!: DreamSessionState
        let error: string | undefined
        let profileDetail = ''
        try {
            if (input.mode === 'incremental') {
                state = createDreamSessionState(input.memoryIds, 'incremental')
                const plan = await buildIncrementalDreamBatches(
                    presetId,
                    input.memoryIds,
                    this.repository,
                    this.search,
                    logger,
                    signal
                )
                if (this.userProfiles.enabled)
                    state.profileSpeakerKeys = new Set(plan.speakerKeys)
                state.batches = plan.batches
                state.untouchedSeedIds = plan.untouchedSeedIds
            } else {
                await this.planningQueue.run('dream-planning', async () => {
                    signal?.throwIfAborted()
                    const entries =
                        await this.repository.listDreamEntriesByPreset(presetId)
                    state = createDreamSessionState(
                        entries.map((entry) => entry.id)
                    )
                    state.batches = await this.clusterer.buildClusters(
                        presetId,
                        entries,
                        logger,
                        signal
                    )
                })
            }
            if (
                state.batches.length > 0 ||
                (this.userProfiles.enabled &&
                    (state.profileSpeakerKeys?.size ?? 0) > 0)
            ) {
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
                if (state.batches.length > 0) {
                    const callOptions = createDreamCallOptions(model, sessionId)
                    signal?.throwIfAborted()
                    const presetPrompt =
                        await this.presetPersona.resolveOrGenerateCardText(
                            presetId
                        )
                    signal?.throwIfAborted()
                    const speakers =
                        await this.mutations.ensurePresetSpeakersCoverage(
                            presetId
                        )
                    signal?.throwIfAborted()
                    const tools = createDreamSessionTools({
                        presetId,
                        state,
                        repository: this.repository,
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
                        signal,
                        loadBatch:
                            input.mode === 'incremental'
                                ? (batch) =>
                                      refreshIncrementalDreamBatch(
                                          presetId,
                                          batch,
                                          this.repository
                                      )
                                : undefined
                    })
                    signal?.throwIfAborted()
                }
                if (
                    this.userProfiles.enabled &&
                    (state.profileSpeakerKeys === undefined ||
                        state.profileSpeakerKeys.size > 0)
                ) {
                    profileDetail = await this.regenerateUserProfilesAfterDream(
                        presetId,
                        model,
                        logger,
                        signal,
                        state.profileSpeakerKeys === undefined
                            ? undefined
                            : [...state.profileSpeakerKeys]
                    )
                }
            }
            signal?.throwIfAborted()
        } catch (cause) {
            // 捕获目标之前的失败交由任务入口记录，之后的失败保留覆盖明细。
            if (state === undefined) throw cause
            error = formatErrorDetails(cause)
        }
        const coverage = getDreamCoverage(state)
        let status: DreamRunResult['status'] = 'completed'
        if (
            error !== undefined ||
            (coverage.processedCount === 0 &&
                (input.mode === 'full' || coverage.targetCount > 0))
        ) {
            status = 'failed'
        } else if (coverage.unprocessedMemoryIds.length > 0) {
            status = 'partial'
        }
        const detail = [
            `dream: ${status}, processed ${coverage.processedCount}/${coverage.targetCount}, batches ${state.batches.length}`,
            `checked ${state.stats.kept}, merged ${state.stats.merged}, split ${state.stats.split}, updated ${state.stats.updated}, archived ${state.stats.archived}`,
            ...state.skippedBatches.map(
                (batch) =>
                    `skipped ${batch.batchId}: ${batch.reason}; memoryIds=${batch.memoryIds.join(', ')}`
            ),
            ...state.completedBatches.map(
                (batch) =>
                    `batch ${batch.batchId}: processed ${batch.processedCount}/${batch.targetCount}; unprocessed=${batch.unprocessedMemoryIds.join(', ') || 'none'}`
            ),
            `untouched seeds: ${state.untouchedSeedIds.join(', ') || 'none'}`,
            `unprocessed: ${coverage.unprocessedMemoryIds.join(', ') || 'none'}`,
            error === undefined ? '' : `error: ${error}`,
            profileDetail
        ]
            .filter(Boolean)
            .join('\n')
        return {
            untouchedSeedIds: state.untouchedSeedIds,
            status,
            entryCount: coverage.targetCount,
            batchCount: state.batches.length,
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
        signal?: AbortSignal,
        involvedSpeakerKeys?: string[]
    ) {
        const startedAt = performance.now()
        logger.diagnosticSummary(() => ({
            event: 'Dream 人物画像处理开始',
            detail: `预设：${presetId}`
        }))
        const speakerKeys =
            involvedSpeakerKeys ??
            (await this.repository.listActiveMemorySpeakerKeys(presetId))
        const result = await this.userProfiles.regenerate(
            presetId,
            speakerKeys,
            model,
            logger,
            signal
        )
        logger.diagnosticSummary(() => ({
            event: 'Dream 人物画像处理结束',
            detail: `预设：${presetId}; ${result.detail}; 耗时：${((performance.now() - startedAt) / 1000).toFixed(3)} 秒`
        }))
        return result.detail
    }
}
