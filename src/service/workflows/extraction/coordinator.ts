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
    LivingMemoryCompletedRound,
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'

type LivingMemoryExtractionConfig = Pick<
    LivingMemoryConfig,
    'extractionInterval' | 'extractionRounds'
>

type ExtractionFormatter = Pick<
    LivingMemoryMessageFormatter,
    'toExtractionPayload'
>
type ExtractionModel = Pick<LivingMemoryExtractor, 'extractWithTrace'>
type ExtractionLogger = Pick<Logger, 'warn'>

interface ExtractionRoundRequest {
    scope: MemoryScope
    resolvePresetPrompt: () => Promise<string>
}

interface BufferedExtractionRound {
    sequence: number
    round: LivingMemoryCompletedRound
}

interface ExtractionScopeState {
    scope: Pick<MemoryScope, 'conversationId' | 'presetId'>
    lastCompletedSequence: number
    lastConsumedSequence: number
    rounds: BufferedExtractionRound[]
    triggerRequests: Map<number, ExtractionRoundRequest>
}

export type ExtractionWorkflowRepository = Pick<
    JobRepository,
    'createFailedJob'
> &
    Pick<ExtractionRepository, 'appendMemories'>

export class LivingMemoryExtractionCoordinator {
    private readonly stateByScope = new Map<string, ExtractionScopeState>()
    private readonly runningScopeKeys = new Set<string>()

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
        for (const key of this.stateByScope.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.stateByScope.delete(key)
            }
        }
    }

    async queue(
        scope: MemoryScope,
        completedRound: LivingMemoryCompletedRound,
        options: QueueExtractionOptions
    ) {
        this.debug(
            [
                'queueExtraction completed round:',
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `interval=${this.config.extractionInterval}`,
                `roundMessagesLength=${completedRound.messages.length}`
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

        const hasUser = completedRound.messages.some(
            (message) => message.role === 'user'
        )
        const hasAssistant = completedRound.messages.some(
            (message) => message.role === 'assistant'
        )
        if (!hasUser || !hasAssistant) {
            throw new Error(
                'Extraction completed round must contain both user and assistant messages.'
            )
        }

        const key = scopeKey(scope)
        const state = this.stateByScope.get(key) ?? {
            scope,
            lastCompletedSequence: 0,
            lastConsumedSequence: 0,
            rounds: [],
            triggerRequests: new Map()
        }

        state.lastCompletedSequence += 1
        state.scope = scope
        state.rounds.push({
            sequence: state.lastCompletedSequence,
            round: completedRound
        })
        if (
            state.lastCompletedSequence % this.config.extractionInterval ===
            0
        ) {
            state.triggerRequests.set(state.lastCompletedSequence, {
                scope,
                resolvePresetPrompt: options.resolvePresetPrompt
            })
        }
        this.stateByScope.set(key, state)

        this.tryStart(key, state)
    }

    private tryStart(key: string, state: ExtractionScopeState) {
        const pendingRounds =
            state.lastCompletedSequence - state.lastConsumedSequence
        const latestScope = state.scope

        if (this.runningScopeKeys.has(key)) {
            this.debug(
                [
                    'queueExtraction pending: extraction running,',
                    `conversationId=${latestScope?.conversationId ?? 'unknown'}`,
                    `pendingRounds=${pendingRounds}`
                ].join(' ')
            )
            return
        }

        if (pendingRounds < this.config.extractionInterval) {
            this.debug(
                [
                    'queueExtraction pending: interval not reached,',
                    `conversationId=${latestScope?.conversationId ?? 'unknown'}`,
                    `pendingRounds=${pendingRounds}`,
                    `interval=${this.config.extractionInterval}`
                ].join(' ')
            )
            return
        }

        const triggerSequence =
            state.lastConsumedSequence + this.config.extractionInterval
        const triggerIndex = state.rounds.findIndex(
            (item) => item.sequence === triggerSequence
        )
        if (triggerIndex < 0) {
            throw new Error(
                `Extraction round buffer is missing trigger sequence ${triggerSequence}.`
            )
        }

        const selectedRounds = state.rounds.slice(
            Math.max(0, triggerIndex - this.config.extractionRounds + 1),
            triggerIndex + 1
        )
        const rounds = selectedRounds.flatMap((item) => item.round.messages)
        const request = state.triggerRequests.get(triggerSequence)
        if (request == null) {
            throw new Error(
                `Extraction round buffer is missing trigger request ${triggerSequence}.`
            )
        }
        state.triggerRequests.delete(triggerSequence)

        this.debug(
            [
                'queueExtraction accepted:',
                `conversationId=${request.scope.conversationId}`,
                `presetId=${request.scope.presetId}`,
                `triggerSequence=${triggerSequence}`,
                `pendingRounds=${pendingRounds}`,
                `bufferedRounds=${selectedRounds.length}`,
                `messagesLength=${rounds.length}`
            ].join(' ')
        )

        this.runningScopeKeys.add(key)
        this.run(request.scope, rounds, request.resolvePresetPrompt)
            .catch((error) => {
                this.logger.warn(error)
            })
            .finally(() => {
                this.runningScopeKeys.delete(key)
                const currentState = this.stateByScope.get(key)
                if (currentState == null) {
                    return
                }

                if (currentState === state) {
                    state.lastConsumedSequence = triggerSequence
                    const minimumSequenceToKeep = Math.max(
                        1,
                        state.lastConsumedSequence -
                            this.config.extractionRounds +
                            2
                    )
                    state.rounds = state.rounds.filter(
                        (item) => item.sequence >= minimumSequenceToKeep
                    )
                }

                if (
                    currentState.lastCompletedSequence -
                        currentState.lastConsumedSequence >=
                    this.config.extractionInterval
                ) {
                    this.tryStart(key, currentState)
                }
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

        // 结果工具在一次纠正重试后仍无法通过校验：持久化失败记录，
        // 使任务列表如实反映“结构化输出失败”而非“抽取 0 条”。
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
