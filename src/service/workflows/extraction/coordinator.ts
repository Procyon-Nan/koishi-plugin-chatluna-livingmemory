import { Context, Logger } from 'koishi'
import type { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { LivingMemoryRepository } from '../../repository'
import { LivingMemoryExtractor } from './extractor'
import { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import { summarizeError } from '../../shared/utils'
import {
    type DebugLogger,
    formatMemoryItemsForLog,
    type QueueExtractionOptions,
    renderChatLunaPresetPrompt,
    scopeKey
} from '../../memory/helpers'
import { LivingMemoryJobTracker } from '../job_tracker'
import type {
    LivingMemoryConfig,
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../types'

export class LivingMemoryExtractionCoordinator {
    private readonly extractionLockByConversation = new Set<string>()
    private readonly lastExtractionChatCountByScope = new Map<string, number>()

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig,
        private readonly repository: LivingMemoryRepository,
        private readonly formatter: LivingMemoryMessageFormatter,
        private readonly extractor: LivingMemoryExtractor,
        private readonly jobTracker: LivingMemoryJobTracker,
        private readonly queueAutoDream: (presetId: string) => void,
        private readonly logger: Logger,
        private readonly debug: DebugLogger
    ) {}

    clearByConversation(conversationId: string) {
        for (const key of this.lastExtractionChatCountByScope.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.lastExtractionChatCountByScope.delete(key)
            }
        }
    }

    async queue(
        scope: MemoryScope,
        chatCount: number,
        messages: LivingMemoryTranscriptMessage[],
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {},
        options: QueueExtractionOptions = {}
    ) {
        this.debug(
            [
                'queueExtraction:',
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `chatCount=${chatCount}`,
                `interval=${this.config.extractionInterval}`,
                `messagesLength=${messages.length}`
            ].join(' ')
        )

        if (this.config.extractionInterval <= 0) {
            this.debug(
                [
                    'queueExtraction skipped: auto extraction disabled,',
                    `conversationId=${scope.conversationId}`,
                    `interval=${this.config.extractionInterval}`
                ].join(' ')
            )
            return
        }

        const lockKey = scopeKey(scope)
        const lastExtractionChatCount =
            this.lastExtractionChatCountByScope.get(lockKey)

        // 首次见到该 scope（含插件重载/重启后内存计数丢失的情形）：chatCount 的
        // 来源（core 累加值 / character 现数）与抽取基线不保证同步归零，直接用其
        // 绝对值会误触发立即抽取。改为以当前 chatCount 为基线、从 0 重新计时，
        // 本次跳过，之后按增量 chatCount - 基线 判定。代价是重载后抽取倒计时会
        // 重置一个 interval，与本插件“尽力而为、容忍滞后”的取舍一致。
        if (lastExtractionChatCount == null) {
            this.lastExtractionChatCountByScope.set(lockKey, chatCount)
            this.debug(
                [
                    'queueExtraction skipped: baseline initialized,',
                    `conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `baselineChatCount=${chatCount}`,
                    `interval=${this.config.extractionInterval}`
                ].join(' ')
            )
            return
        }

        const roundsSinceLastExtraction = chatCount - lastExtractionChatCount

        if (roundsSinceLastExtraction < this.config.extractionInterval) {
            this.debug(
                [
                    'queueExtraction skipped: interval not reached,',
                    `conversationId=${scope.conversationId}`,
                    `chatCount=${chatCount}`,
                    `lastExtractionChatCount=${lastExtractionChatCount ?? 'none'}`,
                    `roundsSinceLastExtraction=${roundsSinceLastExtraction}`,
                    `interval=${this.config.extractionInterval}`
                ].join(' ')
            )
            return
        }

        if (this.extractionLockByConversation.has(lockKey)) {
            this.debug(
                `queueExtraction skipped: locked, conversationId=${scope.conversationId}`
            )
            return
        }

        const rounds =
            options.preselectedMessages ??
            this.formatter.takeRecentRounds(
                messages,
                this.config.extractionRounds
            )
        if (rounds.length === 0) {
            this.debug(
                [
                    'queueExtraction skipped: no complete rounds,',
                    `conversationId=${scope.conversationId}`,
                    `messagesLength=${messages.length}`,
                    `extractionRounds=${this.config.extractionRounds}`
                ].join(' ')
            )
            return
        }

        this.debug(
            [
                'queueExtraction accepted:',
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `roundsLength=${rounds.length}`
            ].join(' ')
        )

        this.extractionLockByConversation.add(lockKey)

        this.run(
            scope,
            rounds,
            presetTemplate,
            promptVariables,
            options.presetPromptOverride
        )
            .then(() => {
                this.lastExtractionChatCountByScope.set(lockKey, chatCount)
            })
            .catch((error) => {
                this.logger.warn(error)
            })
            .finally(() => {
                this.extractionLockByConversation.delete(lockKey)
            })
    }

    private async run(
        scope: MemoryScope,
        messages: LivingMemoryTranscriptMessage[],
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {},
        presetPromptOverride?: string | null
    ) {
        const payload = this.formatter.toExtractionPayload(messages)
        const job = await this.repository.createJob(
            scope,
            'extract',
            payload.input
        )

        this.debug(
            [
                `runExtraction started: jobId=${job.id}`,
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `sourceOriginMessages=${payload.sourceOriginMessages.length}`,
                `inputLength=${payload.input.length}`
            ].join(' ')
        )

        try {
            await this.jobTracker.markRunning(job.id)

            const presetPrompt =
                presetPromptOverride ??
                (await this.renderPresetPrompt(
                    scope,
                    presetTemplate,
                    promptVariables
                ))
            const trace = await this.extractor.extractWithTrace(payload.input, {
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                presetLabel: scope.presetLabel,
                presetPrompt
            })
            if (trace.skippedReason != null) {
                this.debug(
                    [
                        `memory extraction skipped: jobId=${job.id}`,
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `reason=${trace.skippedReason}`
                    ].join(' ')
                )
            }

            if (trace.prompt != null && trace.output != null) {
                this.debug(
                    [
                        `memory extraction llm input: jobId=${job.id}`,
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        trace.prompt
                    ].join('\n')
                )
                this.debug(
                    [
                        `memory extraction llm output: jobId=${job.id}`,
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        trace.output
                    ].join('\n')
                )
            }

            // 模型输出无法解析为合法 JSON 数组：不做修复或重试，仅记录日志，
            // 并将作业标记为失败，使任务列表如实反映“解析失败”而非“抽取 0 条”。
            if (trace.parseError != null) {
                this.debug(
                    [
                        `memory extraction parse failed: jobId=${job.id}`,
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `parseError=${trace.parseError}`
                    ].join(' ')
                )
                await this.jobTracker.markFailed(
                    job.id,
                    `extraction parse failed: ${trace.parseError}`
                )
                return
            }

            const extracted = trace.extracted
            this.debug(
                [
                    `memory extraction: jobId=${job.id}`,
                    `conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `count=${extracted.length}\n${formatMemoryItemsForLog(extracted)}`
                ].join(' ')
            )

            if (extracted.length > 0) {
                await this.repository.appendMemories(
                    scope,
                    payload.sourceOriginMessages,
                    extracted
                )
            }

            await this.jobTracker.markCompleted(
                job.id,
                `extracted ${extracted.length} memories`
            )
            this.debug(
                `runExtraction completed: jobId=${job.id}, extracted=${extracted.length}`
            )
            if (extracted.length > 0) {
                this.queueAutoDream(scope.presetId)
            }
        } catch (error) {
            await this.jobTracker.markFailed(job.id, error)
            throw error
        }
    }

    private async renderPresetPrompt(
        scope: MemoryScope,
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {}
    ) {
        if (presetTemplate == null) {
            this.debug(
                [
                    `memory extraction preset prompt skipped: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    'reason=preset-unavailable'
                ].join(' ')
            )
            return null
        }

        try {
            const presetPrompt = await renderChatLunaPresetPrompt(
                this.ctx,
                presetTemplate,
                promptVariables
            )
            if (presetPrompt == null) {
                this.debug(
                    [
                        `memory extraction preset prompt skipped: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        'reason=empty-rendered-prompt'
                    ].join(' ')
                )
            }

            return presetPrompt
        } catch (error) {
            this.debug(
                [
                    `memory extraction preset prompt skipped: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    'reason=render-failed',
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
            return null
        }
    }
}
