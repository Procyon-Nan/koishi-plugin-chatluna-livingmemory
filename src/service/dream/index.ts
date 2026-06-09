import { Context } from 'koishi'
import type { LivingMemoryConfig, MemoryEntryRecord } from '../../types'
import type { LivingMemoryRepository } from '../repository'
import {
    isModelConfigured,
    stringifyModelContent,
    summarizeError
} from '../shared/utils'
import { DreamClusterer } from './clustering'
import { DreamExecutor } from './executor'
import { parseDreamOperations } from './parser'
import { buildDreamPrompt } from '../prompts'
import {
    addStats,
    createEmptyStageResult,
    createEmptyStats,
    formatStageDetail,
    sumStats
} from './stats'
import type { DreamRunResult, DreamStage, DreamStageResult } from './types'

export type { DreamRunResult } from './types'

export class LivingMemoryDreamService {
    private readonly clusterer: DreamClusterer
    private readonly executor: DreamExecutor

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig,
        private readonly repository: LivingMemoryRepository,
        private readonly debug: (message: string) => void
    ) {
        this.clusterer = new DreamClusterer(ctx, config, repository, debug)
        this.executor = new DreamExecutor(repository)
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
        const invokeModel = async (prompt: string) => {
            const result = await chatModel.invoke(prompt)
            return stringifyModelContent(result.content)
        }

        const activeResult = await this.runStage(
            presetId,
            'active',
            activeEntries,
            invokeModel
        )
        const refreshedEntries =
            await this.repository.listEntriesByPreset(presetId)
        const archivedEntries = refreshedEntries.filter(
            (entry) => entry.status === 'archived'
        )
        const archivedResult = await this.runStage(
            presetId,
            'archived',
            archivedEntries,
            invokeModel
        )
        const stats = sumStats([activeResult, archivedResult])
        const detail = [activeResult.detail, archivedResult.detail].join('\n')

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

    private async runStage(
        presetId: string,
        stage: DreamStage,
        entries: MemoryEntryRecord[],
        invokeModel: (prompt: string) => Promise<string>
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
            const prompt = buildDreamPrompt(presetId, cluster, stage)
            this.debug(
                [
                    `memory dream llm input: presetId=${presetId}`,
                    `stage=${stage}`,
                    `clusterId=${cluster.id}`,
                    prompt
                ].join('\n')
            )

            let output: string
            try {
                output = await invokeModel(prompt)
            } catch (error) {
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
                    output
                ].join('\n')
            )

            const { operations, parseError } = parseDreamOperations(output)
            if (operations.length === 0) {
                stats.skipped++
                this.debug(
                    [
                        `memory dream cluster skipped: presetId=${presetId}`,
                        `stage=${stage}`,
                        `clusterId=${cluster.id}`,
                        parseError != null
                            ? `reason=parse-failed error=${parseError}`
                            : 'reason=no-valid-operations'
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
