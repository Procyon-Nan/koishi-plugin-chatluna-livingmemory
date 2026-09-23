import { randomUUID } from 'node:crypto'
import type {
    LivingMemoryExtractionTrace,
    LivingMemoryExtractor
} from './extractor'
import type { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import type { MemoryTranscriptOrigin } from '../../transcript/origin_context'
import { type QueueExtractionOptions, scopeKey } from '../../memory/helpers'
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
import type { LivingMemoryLogger } from '../../logging/logger'
import type { MessageLogRegistry } from '../../transcript/message_log/message_log_registry'
import type { ConversationLogMessage } from '../../transcript/message_log/types'
import { toLogTranscriptMessages } from '../../transcript/message_log/converter'

type LivingMemoryExtractionConfig = Pick<
    LivingMemoryConfig,
    | 'extractionWindowMessages'
    | 'extractionIncludeOverheard'
    | 'enableExtractionWhitelist'
    | 'extractionWhitelist'
>

type ExtractionFormatter = Pick<
    LivingMemoryMessageFormatter,
    'toExtractionPayload'
>
type ExtractionModel = Pick<LivingMemoryExtractor, 'extractWithTrace'>

/** 提取排干所需的消息日志读取面。 */
export type ExtractionMessageLog = Pick<
    MessageLogRegistry,
    'warmup' | 'isWarm' | 'afterSeq' | 'tailSeq' | 'countSince'
>

interface ExtractionScopeState {
    conversationId: string
    /** 上次成功（或放弃）块末条的日志序号；首个合规 after-chat 时初始化为当时末序号。 */
    cursorSeq: number
    /** 当前块连续失败次数；达到上限后放弃该块（记任务、推进游标、续排后续块）。 */
    failStreak: number
}

export type ExtractionJobRepository = Pick<JobRepository, 'createFailedJob'>

export type ExtractionMemoryWriter = Pick<
    ExtractionRepository,
    'appendMemories'
>

const EXTRACTION_FAIL_STREAK_LIMIT = 3

/**
 * 锚定模式切块：段（一轮＝触发消息＋回复 run）是不可分割的原子单位。
 * 从最新段向旧并入整段，累计不超过「窗口 + 半窗」即并入同块——窗口是
 * 模糊预算而非硬上限，盈余不超过半窗不开新块，最新一轮不因回复多条
 * 被拆开或切走上下文；余量更大时作为前序块继续同规则提取；超出预算的
 * 段独立成块、不截断，不丢消息。
 */
const planAnchoredChunks = (
    segments: readonly ConversationLogMessage[][],
    window: number
): ConversationLogMessage[][] => {
    const absorbLimit = window + Math.floor(window / 2)
    const chunks: ConversationLogMessage[][] = []
    let consumed = segments.length

    while (consumed > 0) {
        let start = consumed - 1
        let size = segments[consumed - 1].length
        while (start > 0 && size + segments[start - 1].length <= absorbLimit) {
            start -= 1
            size += segments[start].length
        }
        chunks.unshift(segments.slice(start, consumed).flat())
        consumed = start
    }

    return chunks
}

/**
 * 段锚定切块：以「连续 assistant 段的末条 assistant」闭合段——末尾无
 * assistant 收尾的尾巴留在积压等下次。参与锚定模式按 planAnchoredChunks
 * 以段为原子单位从尾向旧成块；旁听模式下按窗口切分全部提取、子块边界
 * 尽量落在 assistant 之后。
 */
export const planExtractionChunks = (
    entries: readonly ConversationLogMessage[],
    window: number,
    includeOverheard: boolean
): ConversationLogMessage[][] => {
    if (window <= 0 || entries.length === 0) {
        return []
    }

    const segments: ConversationLogMessage[][] = []
    let current: ConversationLogMessage[] = []
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        current.push(entry)
        const closesSegment =
            entry.role === 'assistant' &&
            (index + 1 === entries.length ||
                entries[index + 1].role !== 'assistant')
        if (closesSegment) {
            segments.push(current)
            current = []
        }
    }

    if (!includeOverheard) {
        return planAnchoredChunks(segments, window)
    }

    const chunks: ConversationLogMessage[][] = []
    let buffer: ConversationLogMessage[] = []
    const flushBuffer = () => {
        if (buffer.length > 0) {
            chunks.push(buffer)
            buffer = []
        }
    }

    for (const segment of segments) {
        if (segment.length > window) {
            flushBuffer()
            let start = 0
            while (segment.length - start > window) {
                let lastAssistant = -1
                for (let index = start; index < start + window; index += 1) {
                    if (segment[index].role === 'assistant') {
                        lastAssistant = index
                    }
                }
                const cut =
                    lastAssistant >= 0 ? lastAssistant + 1 : start + window
                chunks.push(segment.slice(start, cut))
                start = cut
            }
            chunks.push(segment.slice(start))
            continue
        }

        if (buffer.length + segment.length > window) {
            flushBuffer()
        }
        buffer.push(...segment)
    }
    flushBuffer()

    return chunks
}

export class LivingMemoryExtractionCoordinator {
    private readonly stateByScope = new Map<string, ExtractionScopeState>()
    private readonly runningScopeKeys = new Set<string>()

    constructor(
        private readonly config: LivingMemoryExtractionConfig,
        private readonly messageLog: ExtractionMessageLog,
        private readonly jobRepository: ExtractionJobRepository,
        private readonly memoryWriter: ExtractionMemoryWriter,
        private readonly formatter: ExtractionFormatter,
        private readonly extractor: ExtractionModel,
        private readonly queueAutoDream: (presetId: string) => void,
        private readonly logger: LivingMemoryLogger
    ) {}

    async queue(scope: MemoryScope, options: QueueExtractionOptions) {
        const window = this.config.extractionWindowMessages
        if (window === 0) {
            this.logger.diagnostic('extraction.skipped', {
                workflow: 'extraction',
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                window,
                reason: 'disabled'
            })
            return
        }

        // 白名单只挡提取，不挡日志（召回依赖日志）。未命中时游标不初始化，
        // 后续加入白名单从当时刻重新起算，不倾泻积压。
        if (this.config.enableExtractionWhitelist) {
            const sessionId = this.resolveWhitelistId(scope)
            if (
                sessionId == null ||
                !this.config.extractionWhitelist.includes(sessionId)
            ) {
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

        await this.messageLog.warmup(scope.conversationId)

        // 游标初始化的前提是日志已含全部回填内容；回填失败待重试时跳过，
        // 否则重试落地的平台历史会追加在游标之后被整段重复提取。
        if (!this.messageLog.isWarm(scope.conversationId)) {
            this.logger.diagnostic('extraction.skipped', {
                workflow: 'extraction',
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                reason: 'backfill-pending'
            })
            return
        }

        const key = scopeKey(scope)
        const state = this.stateByScope.get(key) ?? {
            // 冷启动游标：首个合规 after-chat 时点的末序号，不回溯平台历史
            conversationId: scope.conversationId,
            cursorSeq: this.messageLog.tailSeq(scope.conversationId) ?? 0,
            failStreak: 0
        }
        this.stateByScope.set(key, state)

        const backlog = this.messageLog.countSince(
            scope.conversationId,
            state.cursorSeq
        )
        if (backlog < window) {
            this.logger.diagnostic('extraction.pending', {
                workflow: 'extraction',
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                backlog,
                window,
                reason: 'window-not-reached'
            })
            return
        }

        if (this.runningScopeKeys.has(key)) {
            this.logger.diagnostic('extraction.pending', {
                workflow: 'extraction',
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                backlog,
                reason: 'running'
            })
            return
        }

        this.drain(key, state, scope, options).catch((error) => {
            this.logger.warn(
                'extraction.failed',
                { operation: 'drain', conversationId: scope.conversationId },
                error
            )
        })
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

    /** 白名单以用户可直接填写的平台 id 为准：群聊比对群号，私聊比对用户 id。 */
    private resolveWhitelistId(scope: MemoryScope) {
        return scope.isDirect === true ? scope.userId : scope.guildId
    }

    private async drain(
        key: string,
        state: ExtractionScopeState,
        scope: MemoryScope,
        options: QueueExtractionOptions
    ) {
        this.runningScopeKeys.add(key)
        const runLogger = this.logger.with({
            workflow: 'extraction',
            runId: randomUUID(),
            conversationId: scope.conversationId,
            presetId: scope.presetId
        })

        try {
            while (true) {
                // 会话清理已移除或重建状态：旧游标立即失效，终止本次排干；
                // 正在执行的单次模型调用照常完成，后续消息由新状态的
                // 下一次触发接管。
                if (this.stateByScope.get(key) !== state) {
                    runLogger.diagnostic('extraction.drain.stopped', {
                        reason: 'state-cleared'
                    })
                    return
                }
                const entries = this.messageLog.afterSeq(
                    scope.conversationId,
                    state.cursorSeq
                )
                const chunks = planExtractionChunks(
                    entries,
                    this.config.extractionWindowMessages,
                    this.config.extractionIncludeOverheard
                )
                const chunk = chunks[0]
                if (chunk == null) {
                    return
                }

                runLogger.diagnostic('extraction.started', {
                    backlog: entries.length,
                    chunkMessages: chunk.length
                })

                const messages = await toLogTranscriptMessages(
                    scope,
                    scope.platform ?? 'unknown',
                    chunk
                )
                try {
                    await this.run(scope, messages, options, runLogger)
                    state.cursorSeq = chunk[chunk.length - 1].seq
                    state.failStreak = 0
                } catch (error) {
                    state.failStreak += 1
                    if (state.failStreak < EXTRACTION_FAIL_STREAK_LIMIT) {
                        runLogger.warn(
                            'extraction.chunk.retry-deferred',
                            {
                                operation: 'drain',
                                failStreak: state.failStreak,
                                cursorSeq: state.cursorSeq
                            },
                            error
                        )
                        return
                    }

                    // 连续失败达到上限：放弃该块，记任务后续排，防止游标永久卡死
                    runLogger.warn(
                        'extraction.chunk.abandoned',
                        {
                            operation: 'drain',
                            failStreak: state.failStreak,
                            cursorSeq: state.cursorSeq,
                            chunkEndSeq: chunk[chunk.length - 1].seq
                        },
                        error
                    )
                    await this.recordFailedExtraction(
                        scope,
                        this.formatter.toExtractionPayload(messages).input,
                        error,
                        new Date()
                    )
                    state.cursorSeq = chunk[chunk.length - 1].seq
                    state.failStreak = 0
                }
            }
        } finally {
            this.runningScopeKeys.delete(key)
        }
    }

    private async run(
        scope: MemoryScope,
        messages: LivingMemoryTranscriptMessage[],
        options: QueueExtractionOptions,
        logger: LivingMemoryLogger
    ) {
        const startedAt = new Date()
        let input = ''
        let payload: ExtractionPayload
        let trace: LivingMemoryExtractionTrace
        let origin: MemoryTranscriptOrigin

        payload = this.formatter.toExtractionPayload(messages)
        input = payload.input
        origin = await options.resolveTranscriptOrigin()
        input = `${origin.header}\n\n${input}`

        logger.diagnostic('extraction.input.prepared', {
            sourceOriginMessages: payload.sourceOriginMessages.length,
            inputLength: input.length
        })

        const presetPrompt = await options.resolvePresetPrompt()
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
        if (extracted.length > 0) {
            await this.memoryWriter.appendMemories(
                scope,
                payload.sourceOriginMessages,
                extracted,
                origin.sourceLabel
            )
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
