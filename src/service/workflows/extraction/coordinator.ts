import type { Logger } from 'koishi'
import type {
    LivingMemoryExtractionTrace,
    LivingMemoryExtractor
} from './extractor'
import type { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import {
    type DebugLogger,
    formatMemoryItemsForLog,
    type QueueExtractionOptions,
    scopeKey
} from '../../memory/helpers'
import type {
    ExtractionPayload,
    ExtractionRepository,
    JobRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'

type LivingMemoryExtractionConfig = Pick<
    LivingMemoryConfig,
    'extractionInterval' | 'extractionRounds'
>

type ExtractionFormatter = Pick<
    LivingMemoryMessageFormatter,
    'takeRecentRounds' | 'toExtractionPayload'
>
type ExtractionModel = Pick<LivingMemoryExtractor, 'extractWithTrace'>
type ExtractionLogger = Pick<Logger, 'warn'>

export type ExtractionWorkflowRepository = Pick<
    JobRepository,
    'createFailedJob'
> &
    Pick<ExtractionRepository, 'appendMemories'>

export class LivingMemoryExtractionCoordinator {
    private readonly extractionLockByConversation = new Set<string>()
    private readonly lastExtractionChatCountByScope = new Map<string, number>()

    constructor(
        private readonly config: LivingMemoryExtractionConfig,
        private readonly repository: ExtractionWorkflowRepository,
        private readonly formatter: ExtractionFormatter,
        private readonly extractor: ExtractionModel,
        private readonly queueAutoDream: (presetId: string) => void,
        private readonly logger: ExtractionLogger,
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
        options: QueueExtractionOptions
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

        this.run(scope, rounds, options.resolvePresetPrompt)
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
        resolvePresetPrompt: () => Promise<string>
    ) {
        const startedAt = new Date()
        let input = ''
        let payload: ExtractionPayload
        let trace: LivingMemoryExtractionTrace

        try {
            payload = this.formatter.toExtractionPayload(messages)
            input = payload.input

            this.debug(
                [
                    'runExtraction started:',
                    `conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `sourceOriginMessages=${payload.sourceOriginMessages.length}`,
                    `inputLength=${payload.input.length}`
                ].join(' ')
            )

            const presetPrompt = await resolvePresetPrompt()
            trace = await this.extractor.extractWithTrace(payload.input, {
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                presetLabel: scope.presetLabel,
                presetPrompt
            })
            if (trace.skippedReason != null) {
                this.debug(
                    [
                        'memory extraction skipped:',
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `reason=${trace.skippedReason}`
                    ].join(' ')
                )
            }

            if (trace.prompt != null && trace.output != null) {
                this.debug(
                    [
                        'memory extraction llm input:',
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        trace.prompt
                    ].join('\n')
                )
                this.debug(
                    [
                        'memory extraction llm output:',
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        trace.output
                    ].join('\n')
                )
            }
        } catch (error) {
            await this.repository.createFailedJob(
                scope,
                'extract',
                input,
                error,
                startedAt
            )
            throw error
        }

        // 模型输出无法解析为合法 JSON 数组：不做修复或重试，仅持久化失败记录，
        // 使任务列表如实反映“解析失败”而非“抽取 0 条”。
        if (trace.parseError != null) {
            this.debug(
                [
                    'memory extraction parse failed:',
                    `conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `parseError=${trace.parseError}`
                ].join(' ')
            )
            await this.repository.createFailedJob(
                scope,
                'extract',
                input,
                `extraction parse failed: ${trace.parseError}`,
                startedAt
            )
            return
        }

        const extracted = trace.extracted
        this.debug(
            [
                'memory extraction:',
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `count=${extracted.length}\n${formatMemoryItemsForLog(extracted)}`
            ].join(' ')
        )

        try {
            if (extracted.length > 0) {
                await this.repository.appendMemories(
                    scope,
                    payload.sourceOriginMessages,
                    extracted
                )
            }
        } catch (error) {
            await this.repository.createFailedJob(
                scope,
                'extract',
                input,
                error,
                startedAt
            )
            throw error
        }

        this.debug(`runExtraction completed: extracted=${extracted.length}`)
        if (extracted.length > 0) {
            this.queueAutoDream(scope.presetId)
        }
    }
}
