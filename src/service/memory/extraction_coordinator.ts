import { BaseMessage } from '@langchain/core/messages'
import { Context, Logger } from 'koishi'
import type { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { LivingMemoryRepository } from '../repository'
import { LivingMemoryExtractor } from '../extractor'
import { LivingMemoryMessageFormatter } from '../message_formatter'
import { formatDateOnly, summarizeError } from '../shared/utils'
import {
    type DebugLogger,
    formatMemoryItemsForLog,
    formatRenderedPresetPrompt,
    type QueueExtractionOptions,
    scopeKey
} from './helpers'
import { LivingMemoryJobTracker } from './job_tracker'
import type { LivingMemoryConfig, MemoryScope } from '../../types'

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
        messages: BaseMessage[],
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
        const roundsSinceLastExtraction =
            lastExtractionChatCount == null
                ? chatCount
                : chatCount - lastExtractionChatCount

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
        messages: BaseMessage[],
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {},
        presetPromptOverride?: string | null
    ) {
        const payload = this.formatter.toExtractionPayload(scope, messages)
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
                `sourceMessages=${payload.sourceMessages.length}`,
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
                currentDate: formatDateOnly(new Date()),
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
                    payload.sourceMessages,
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
            const rendered =
                await this.ctx.chatluna.promptRenderer.renderPresetTemplate(
                    presetTemplate,
                    promptVariables
                )
            const presetPrompt = formatRenderedPresetPrompt(rendered.messages)
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
