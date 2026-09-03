import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { ManualDreamVectorReader } from '../../../contracts/vector_index'
import type {
    DreamMemoryEntryRecord,
    DreamMemoryRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import type { PresetSpeakerRecord } from '../../../contracts/memory'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import {
    resolveAssistantLabel,
    resolvePresetPrompt
} from '../../memory/helpers'
import { DreamClusterer } from './clustering'
import type { DreamWorkerRunner } from './worker/protocol'
import type { LivingMemoryUserProfileService } from '../../user_profile'
import { addStats, createEmptyStats, formatDreamDetail } from './stats'
import type { DreamRunResult } from './types'
import { DreamUnitProcessor } from './unit_processor'
import type { LivingMemoryLogger } from '../../logging/logger'

export type { DreamRunResult } from './types'

type LivingMemoryDreamConfig = Pick<LivingMemoryConfig, 'mainModel'>

export interface DreamRepository {
    listDreamEntriesByPreset(
        presetId: string
    ): Promise<DreamMemoryEntryRecord[]>
    listActiveMemorySpeakerKeys(presetId: string): Promise<string[]>
    listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]>
}

export class LivingMemoryDreamService {
    private readonly clusterer: DreamClusterer
    private readonly unitProcessor: DreamUnitProcessor

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryDreamConfig,
        private readonly repository: DreamRepository,
        private readonly mutations: DreamMemoryRepository,
        vectors: ManualDreamVectorReader,
        worker: DreamWorkerRunner,
        private readonly logger: LivingMemoryLogger,
        private readonly userProfiles: LivingMemoryUserProfileService
    ) {
        this.clusterer = new DreamClusterer(vectors, worker)
        this.unitProcessor = new DreamUnitProcessor(mutations)
    }

    async run(
        presetId: string,
        logger?: LivingMemoryLogger
    ): Promise<DreamRunResult> {
        const runLogger =
            logger ??
            this.logger.with({
                workflow: 'dream',
                presetId
            })
        const entries = await this.repository.listDreamEntriesByPreset(presetId)
        if (entries.length === 0) {
            return this.createResult(entries.length, 0, {
                detail: `dream skipped: only ${entries.length} memories`
            })
        }

        let singleEntryResult: DreamRunResult | undefined
        if (entries.length === 1) {
            await this.consolidateSingleEntry(presetId, entries)
            singleEntryResult = this.createResult(1, 0, {
                detail: 'dream skipped: only 1 memories'
            })
            if (!this.userProfiles.enabled) {
                return singleEntryResult
            }
        }

        if (!isModelConfigured(this.config.mainModel)) {
            return this.createModelSkipResult(
                entries.length,
                'model-not-configured',
                singleEntryResult
            )
        }

        const model = await this.ctx.chatluna.createChatModel(
            this.config.mainModel
        )
        if (model.value === undefined) {
            return this.createModelSkipResult(
                entries.length,
                'model-unavailable',
                singleEntryResult
            )
        }

        const chatModel = model.value
        let result = singleEntryResult
        if (result === undefined) {
            const assistantLabel = resolveAssistantLabel(presetId)
            const presetPrompt = await resolvePresetPrompt(this.ctx, presetId)
            const speakers = await this.repository.listPresetSpeakers(presetId)
            result = await this.processEntries(
                presetId,
                assistantLabel,
                presetPrompt,
                entries,
                speakers,
                chatModel,
                runLogger
            )
        }
        const profileDetail = await this.regenerateUserProfilesAfterDream(
            presetId,
            chatModel,
            runLogger
        )
        const detail = [result.detail, profileDetail].join('\n')

        return { ...result, detail }
    }

    /** 不足聚簇规模时，唯一一条记忆直接标记为已固化。 */
    private async consolidateSingleEntry(
        presetId: string,
        entries: DreamMemoryEntryRecord[]
    ) {
        if (entries.length === 1) {
            await this.mutations.setMemoryConsolidation(
                presetId,
                [entries[0].id],
                true
            )
        }
    }

    /**
     * 整理阶段成功后重算画像。候选用户取全部活跃用户，而非本次受影响的用户，
     * 因此整理阶段抛错时不必在此补算：下一次手动 Dream 依然覆盖全部用户，
     * 画像陈旧性判据只会重算输入变过的那些。自动增量流程按累积的受影响用户
     * 集合触发，该集合随本次运行结束即丢失，所以那侧必须在抛错前补算。
     */
    private async regenerateUserProfilesAfterDream(
        presetId: string,
        model: ChatLunaChatModel,
        logger?: LivingMemoryLogger
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
                logger
            )
            return result.detail
        } catch (error) {
            const errorSummary = summarizeError(error)
            const errorMessage =
                error instanceof Error ? error.message : errorSummary
            const detail = `user profiles failed: ${errorMessage}`
            logger?.diagnostic('dream.user-profile.failed', {
                error: errorSummary
            })
            return detail
        }
    }

    private async processEntries(
        presetId: string,
        assistantLabel: string,
        presetPrompt: string,
        entries: DreamMemoryEntryRecord[],
        speakers: PresetSpeakerRecord[],
        model: ChatLunaChatModel,
        logger?: LivingMemoryLogger
    ): Promise<DreamRunResult> {
        logger?.diagnostic('dream.processing.started', {
            entries: entries.length
        })
        const clusters = await this.clusterer.buildClusters(
            presetId,
            entries,
            logger
        )

        const stats = createEmptyStats()
        const touchedMemoryIds = new Set<string>()

        for (const cluster of clusters) {
            const result = await this.unitProcessor.process({
                assistantLabel,
                presetPrompt,
                presetId,
                cluster,
                speakers,
                model,
                touchedMemoryIds,
                consolidationMode: 'manual',
                logger
            })
            addStats(stats, result)
            if (result.success === false) {
                if (result.skipped === 0) {
                    stats.skipped++
                }
                const reason = result.error.split(':', 1)[0]
                logger?.diagnostic('dream.cluster.skipped', {
                    clusterId: cluster.id,
                    reason,
                    error: result.error
                })
            }
        }

        return {
            entryCount: entries.length,
            clusterCount: clusters.length,
            ...stats,
            detail: formatDreamDetail(entries.length, clusters.length, stats)
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
            skipped: 0,
            skippedReason: options.skippedReason,
            detail: options.detail
        }
    }

    /**
     * 模型不可用时的返回。单条记忆分支已经写库固化，它的结果不能被丢弃，
     * 只把画像阶段的跳过原因并入 detail。与画像阶段其余跳过原因一致，这里
     * 不写 skippedReason，该字段只表达整理阶段自身的跳过。
     */
    private createModelSkipResult(
        entryCount: number,
        skippedReason: 'model-not-configured' | 'model-unavailable',
        singleEntryResult: DreamRunResult | undefined
    ): DreamRunResult {
        if (singleEntryResult === undefined) {
            return this.createResult(entryCount, 0, {
                skippedReason,
                detail: `dream skipped: ${skippedReason}`
            })
        }
        return {
            ...singleEntryResult,
            detail: [
                singleEntryResult.detail,
                `user profiles skipped: ${skippedReason}`
            ].join('\n')
        }
    }
}
