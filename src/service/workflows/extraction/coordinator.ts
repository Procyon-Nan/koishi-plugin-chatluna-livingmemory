import { randomUUID } from 'node:crypto'
import type {
    LivingMemoryExtractionTrace,
    LivingMemoryExtractor
} from './extractor'
import type { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import { type QueueExtractionOptions, scopeKey } from '../../memory/helpers'
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
import type { LivingMemoryLogger } from '../../logging/logger'

type LivingMemoryExtractionConfig = Pick<
    LivingMemoryConfig,
    | 'extractionInterval'
    | 'extractionRounds'
    | 'enableExtractionWhitelist'
    | 'extractionWhitelist'
>

type ExtractionFormatter = Pick<
    LivingMemoryMessageFormatter,
    'toExtractionPayload'
>
type ExtractionModel = Pick<LivingMemoryExtractor, 'extractWithTrace'>
interface ExtractionRoundRequest {
    scope: MemoryScope
    resolvePresetPrompt: () => Promise<string>
    resolveTranscriptHeader: () => Promise<string>
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

export type ExtractionJobRepository = Pick<JobRepository, 'createFailedJob'>

export type ExtractionMemoryWriter = Pick<
    ExtractionRepository,
    'appendMemories'
>

export class LivingMemoryExtractionCoordinator {
    private readonly stateByScope = new Map<string, ExtractionScopeState>()
    private readonly runningScopeKeys = new Set<string>()
    private readonly whitelist: Set<string>

    constructor(
        private readonly config: LivingMemoryExtractionConfig,
        private readonly jobRepository: ExtractionJobRepository,
        private readonly memoryWriter: ExtractionMemoryWriter,
        private readonly formatter: ExtractionFormatter,
        private readonly extractor: ExtractionModel,
        private readonly queueAutoDream: (presetId: string) => void,
        private readonly logger: LivingMemoryLogger
    ) {
        this.whitelist = new Set(
            config.extractionWhitelist
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
        )
    }

    clearAll() {
        this.stateByScope.clear()
    }

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
        this.logger.diagnostic('extraction.round.queued', {
            workflow: 'extraction',
            conversationId: scope.conversationId,
            presetId: scope.presetId,
            interval: this.config.extractionInterval,
            messages: completedRound.messages.length
        })

        if (this.config.extractionInterval <= 0) {
            this.logger.diagnostic('extraction.skipped', {
                workflow: 'extraction',
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                interval: this.config.extractionInterval,
                reason: 'disabled'
            })
            return
        }

        // 白名单未命中的会话不进入轮次缓冲：既不累计轮次也不触发提取，
        // 避免后续把该会话加入白名单时立刻消费历史积压轮次。
        if (this.config.enableExtractionWhitelist) {
            const sessionId = this.resolveWhitelistId(scope)
            if (sessionId == null || !this.whitelist.has(sessionId)) {
                this.logger.diagnostic('extraction.skipped', {
                    workflow: 'extraction',
                    conversationId: scope.conversationId,
                    presetId: scope.presetId,
                    sessionId,
                    reason: 'not-whitelisted'
                })
                return
            }
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
        const state: ExtractionScopeState = this.stateByScope.get(key) ?? {
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
                resolvePresetPrompt: options.resolvePresetPrompt,
                resolveTranscriptHeader: options.resolveTranscriptHeader
            })
        }
        this.stateByScope.set(key, state)

        this.tryStart(key, state)
    }

    /**
     * 白名单以用户可直接填写的平台 id 为准：群聊比对群号，私聊比对用户 id。
     */
    private resolveWhitelistId(scope: MemoryScope) {
        return scope.isDirect === true ? scope.userId : scope.guildId
    }

    private tryStart(key: string, state: ExtractionScopeState) {
        const pendingRounds =
            state.lastCompletedSequence - state.lastConsumedSequence
        const latestScope = state.scope

        if (this.runningScopeKeys.has(key)) {
            this.logger.diagnostic('extraction.pending', {
                workflow: 'extraction',
                conversationId: latestScope.conversationId,
                presetId: latestScope.presetId,
                pendingRounds,
                reason: 'running'
            })
            return
        }

        if (pendingRounds < this.config.extractionInterval) {
            this.logger.diagnostic('extraction.pending', {
                workflow: 'extraction',
                conversationId: latestScope.conversationId,
                presetId: latestScope.presetId,
                pendingRounds,
                interval: this.config.extractionInterval,
                reason: 'interval-not-reached'
            })
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

        this.runningScopeKeys.add(key)
        const runLogger = this.logger.with({
            workflow: 'extraction',
            runId: randomUUID(),
            conversationId: request.scope.conversationId,
            presetId: request.scope.presetId,
            triggerSequence
        })
        runLogger.diagnostic('extraction.started', {
            pendingRounds,
            bufferedRounds: selectedRounds.length,
            messages: rounds.length
        })
        this.run(
            request.scope,
            rounds,
            request.resolvePresetPrompt,
            request.resolveTranscriptHeader,
            runLogger
        )
            .catch((error) => {
                runLogger.warn('extraction.failed', { operation: 'run' }, error)
            })
            .finally(() => {
                this.consumeRoundsAfterRun(key, state, triggerSequence)
            })
    }

    /**
     * 一次提取运行结束后消费触发边界：标记触发轮之前的缓冲已消费、
     * 清理不再需要的轮次缓冲，并在积压再次达到间隔时续跑。
     */
    private consumeRoundsAfterRun(
        key: string,
        state: ExtractionScopeState,
        triggerSequence: number
    ) {
        this.runningScopeKeys.delete(key)
        const currentState = this.stateByScope.get(key)
        if (currentState == null) {
            return
        }

        if (currentState === state) {
            state.lastConsumedSequence = triggerSequence
            const minimumSequenceToKeep = Math.max(
                1,
                state.lastConsumedSequence - this.config.extractionRounds + 2
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
    }

    private async run(
        scope: MemoryScope,
        messages: LivingMemoryTranscriptMessage[],
        resolvePresetPrompt: () => Promise<string>,
        resolveTranscriptHeader: () => Promise<string>,
        logger: LivingMemoryLogger
    ) {
        const startedAt = new Date()
        let input = ''
        let payload: ExtractionPayload
        let trace: LivingMemoryExtractionTrace

        try {
            payload = this.formatter.toExtractionPayload(messages)
            input = payload.input
            input = `${await resolveTranscriptHeader()}\n\n${input}`

            logger.diagnostic('extraction.input.prepared', {
                sourceOriginMessages: payload.sourceOriginMessages.length,
                inputLength: input.length
            })

            const presetPrompt = await resolvePresetPrompt()
            trace = await this.extractor.extractWithTrace(
                input,
                {
                    conversationId: scope.conversationId,
                    presetId: scope.presetId,
                    presetLabel: scope.presetLabel,
                    presetPrompt,
                    speakers: payload.speakers
                },
                logger
            )
            if (trace.skippedReason != null) {
                logger.diagnostic('extraction.skipped', {
                    reason: trace.skippedReason
                })
            }
        } catch (error) {
            await this.recordFailedExtraction(scope, input, error, startedAt)
            throw error
        }

        // 结果工具在一次纠正重试后仍无法通过校验：持久化失败记录，
        // 使任务列表如实反映“结构化输出失败”而非“抽取 0 条”。
        if (trace.parseError != null) {
            const parseError = trace.parseError
            logger.diagnostic('extraction.parse.failed', {
                error: parseError
            })
            await this.recordFailedExtraction(
                scope,
                input,
                `extraction parse failed: ${parseError}`,
                startedAt
            )
            return
        }

        const extracted = trace.extracted
        try {
            if (extracted.length > 0) {
                await this.memoryWriter.appendMemories(
                    scope,
                    payload.sourceOriginMessages,
                    extracted
                )
            }
        } catch (error) {
            await this.recordFailedExtraction(scope, input, error, startedAt)
            throw error
        }

        logger.diagnostic('extraction.completed', {
            extracted: extracted.length
        })
        if (extracted.length > 0) {
            this.queueAutoDream(scope.presetId)
        }
    }

    private async recordFailedExtraction(
        scope: MemoryScope,
        input: string,
        error: unknown,
        startedAt: Date
    ) {
        await this.jobRepository.createFailedJob(
            scope,
            'extract',
            input,
            error,
            startedAt
        )
    }
}
