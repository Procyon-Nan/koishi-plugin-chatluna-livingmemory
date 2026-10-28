import { randomUUID } from 'node:crypto'
import type { LivingMemoryExtractor } from './extractor'
import type { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import { type QueueExtractionOptions, scopeKey } from '../../memory/helpers'
import type {
    ExtractionMemoryWriter,
    JobRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope,
    PresetPersonaResolver
} from '../../../contracts/memory'
import { formatLogScope, type LivingMemoryLogger } from '../../logging/logger'
import type { MessageLogRegistry } from '../../transcript/message_log/message_log_registry'
import type { ConversationLogMessage } from '../../transcript/message_log/types'
import { toLogTranscriptMessages } from '../../transcript/message_log/converter'

type LivingMemoryExtractionConfig = Pick<
    LivingMemoryConfig,
    | 'extractionWindowMessages'
    | 'enableExtractionWhitelist'
    | 'extractionWhitelist'
>

type ExtractionFormatter = Pick<
    LivingMemoryMessageFormatter,
    'toExtractionPayload'
>
type ExtractionModel = Pick<LivingMemoryExtractor, 'extract'>

/** 提取排干所需的消息日志读取面。 */
export type ExtractionMessageLog = Pick<
    MessageLogRegistry,
    'warmup' | 'isWarm' | 'afterSeq' | 'tailSeq'
>

interface ExtractionScopeState {
    scope: MemoryScope
    options: QueueExtractionOptions
    /** 上次处理块的末序号；旁听起点在回填完成后解析。 */
    resolveInitialCursor?: () => number
    cursorSeq: number
    /** 当前块连续失败次数；达到上限后放弃该块（记任务、推进游标、续排后续块）。 */
    failStreak: number
}

export type ExtractionJobRepository = Pick<JobRepository, 'createFailedJob'>

const EXTRACTION_FAIL_STREAK_LIMIT = 3

/** 吸收预算：窗口＋半窗。窗口是模糊预算而非硬上限，块内盈余不超过半窗。 */
const calculateChunkMessageBudget = (window: number): number =>
    window + Math.floor(window / 2)

/**
 * 段尾的交流长度：末条用户消息（触发消息）起至回复 run 结束。无用户
 * 消息的段（孤儿回复 run，触发消息未被记录）整段视为一个交流。
 */
const countTrailingExchangeMessages = (
    segment: readonly ConversationLogMessage[]
): number => {
    let exchangeStart = segment.length - 1
    while (exchangeStart > 0 && segment[exchangeStart].role === 'assistant') {
        exchangeStart -= 1
    }
    return segment.length - exchangeStart
}

/**
 * 锚定筛选：交流（触发消息＋回复 run）无条件保留；闲聊只保留最新交流
 * 前方一个提取窗口内的部分——核心边界从积压末尾按「最新交流＋窗口」
 * 条向旧推进，核心内的段整段保留，核心外的段剥掉闲聊只留交流；边界
 * 切进交流时整段交流保留。被丢弃的闲聊随游标推进，不再进入后续提取。
 */
const selectAnchoredUnits = (
    segments: readonly ConversationLogMessage[][],
    window: number
): ConversationLogMessage[][] => {
    if (segments.length === 0) {
        return []
    }

    const units: ConversationLogMessage[][] = []
    let coreRemaining =
        countTrailingExchangeMessages(segments[segments.length - 1]) + window

    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index]
        const covered = Math.min(coreRemaining, segment.length)
        const keepLength = Math.min(
            segment.length,
            Math.max(covered, countTrailingExchangeMessages(segment))
        )
        units.unshift(segment.slice(segment.length - keepLength))
        coreRemaining -= covered
    }

    return units
}

/**
 * 尾锚定装包：以传入的原子单位从最新向旧并入，累计不超过吸收预算即
 * 并入同块——最新内容优先保有上下文；余量更大时作为前序块继续同规则
 * 提取；超出预算的单位独立成块、不截断。锚定模式传入锚定筛选后的单元
 * （核心后缀＋核心外的交流），旁听模式传入切片后的子块。
 */
const packChunksFromLatest = (
    units: readonly ConversationLogMessage[][],
    window: number
): ConversationLogMessage[][] => {
    const absorbLimit = calculateChunkMessageBudget(window)
    const chunks: ConversationLogMessage[][] = []
    let consumed = units.length

    while (consumed > 0) {
        let start = consumed - 1
        let size = units[consumed - 1].length
        while (start > 0 && size + units[start - 1].length <= absorbLimit) {
            start -= 1
            size += units[start].length
        }
        chunks.unshift(units.slice(start, consumed).flat())
        consumed = start
    }

    return chunks
}

/**
 * 旁听切片：超出吸收预算的超长段切成不超过预算的子块，边界尽量落在
 * assistant 之后；预算内的段保持原子。
 */
const splitOverheardUnits = (
    segments: readonly ConversationLogMessage[][],
    window: number
): ConversationLogMessage[][] => {
    const absorbLimit = calculateChunkMessageBudget(window)
    const units: ConversationLogMessage[][] = []
    for (const segment of segments) {
        if (segment.length <= absorbLimit) {
            units.push(segment)
            continue
        }
        let start = 0
        while (segment.length - start > absorbLimit) {
            let lastAssistant = -1
            for (let index = start; index < start + absorbLimit; index += 1) {
                if (segment[index].role === 'assistant') {
                    lastAssistant = index
                }
            }
            const cut =
                lastAssistant >= 0 ? lastAssistant + 1 : start + absorbLimit
            units.push(segment.slice(start, cut))
            start = cut
        }
        units.push(segment.slice(start))
    }
    return units
}

/**
 * 段锚定切块：以连续 assistant 段的末条闭合交流段，旁听模式同时接收
 * 末尾用户消息段。两种模式共用 packChunksFromLatest
 * 从尾向旧模糊装包；锚定模式先经 selectAnchoredUnits 丢弃核心窗口之外
 * 的闲聊，旁听模式先经 splitOverheardUnits 把超预算段切成预算内子块。
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
        return packChunksFromLatest(
            selectAnchoredUnits(segments, window),
            window
        )
    }
    if (current.length > 0) segments.push(current)
    return packChunksFromLatest(splitOverheardUnits(segments, window), window)
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
        private readonly presetPersona: PresetPersonaResolver,
        private readonly logger: LivingMemoryLogger,
        private readonly queueIncrementalDream: (
            presetId: string,
            memoryIds: string[]
        ) => void
    ) {}

    async queue(
        scope: MemoryScope,
        options: QueueExtractionOptions,
        initialCursor?: () => number
    ) {
        if (this.config.extractionWindowMessages === 0) return
        if (!this.isExtractionWhitelisted(scope)) return

        const key = scopeKey(scope)
        if (initialCursor && !this.stateByScope.has(key)) {
            this.clearByConversation(scope.conversationId)
        }
        const state: ExtractionScopeState = this.stateByScope.get(key) ?? {
            scope,
            options,
            cursorSeq: 0,
            resolveInitialCursor:
                initialCursor ??
                (() => this.messageLog.tailSeq(scope.conversationId) ?? 0),
            failStreak: 0
        }
        this.stateByScope.set(key, state)
        await this.messageLog.warmup(scope.conversationId)
        if (!this.messageLog.isWarm(scope.conversationId)) return
        if (this.stateByScope.get(key) !== state) return

        if (state.resolveInitialCursor) {
            state.cursorSeq = state.resolveInitialCursor()
            delete state.resolveInitialCursor
        }
        state.scope = scope
        state.options = options
        this.schedule(key, state)
    }

    private schedule(key: string, state: ExtractionScopeState) {
        const { scope, options } = state
        const window = this.config.extractionWindowMessages

        const backlog = this.messageLog.afterSeq(
            scope.conversationId,
            state.cursorSeq
        ).length
        if (backlog < window) {
            this.logger.diagnosticSummary(() => ({
                event: '等待记忆提取',
                detail: `${formatLogScope(scope)}; 消息提取阈值：${backlog}/${window} 条`
            }))
            return
        }

        if (this.runningScopeKeys.has(key)) {
            this.logger.diagnosticSummary(() => ({
                event: '等待记忆提取',
                detail: `${formatLogScope(scope)}; 当前任务运行中; 待处理消息：${backlog} 条`
            }))
            return
        }

        const runLogger = this.logger.with({
            workflow: 'extraction',
            runId: randomUUID(),
            conversationId: scope.conversationId,
            presetId: scope.presetId
        })
        this.drain(key, state, scope, options, runLogger).catch((error) => {
            runLogger.summary(
                '记忆提取失败',
                (fields) => formatLogScope(fields),
                'warn',
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

    /**
     * 白名单门禁：未开启时全部放行；开启时仅放行 id 命中白名单的会话，
     * 未命中记跳过诊断。白名单只约束自动提取，不影响日志采集与召回。
     */
    private isExtractionWhitelisted(scope: MemoryScope): boolean {
        if (!this.config.enableExtractionWhitelist) {
            return true
        }
        const sessionId = this.resolveWhitelistId(scope)
        if (
            sessionId != null &&
            this.config.extractionWhitelist.includes(sessionId)
        ) {
            return true
        }
        this.logger.diagnosticSummary(() => ({
            event: '跳过记忆提取',
            detail: `${formatLogScope(scope)}; 原因：会话未列入提取白名单`
        }))
        return false
    }

    private async drain(
        key: string,
        state: ExtractionScopeState,
        scope: MemoryScope,
        options: QueueExtractionOptions,
        runLogger: LivingMemoryLogger
    ) {
        this.runningScopeKeys.add(key)

        try {
            while (true) {
                // 会话清理已移除或重建状态：旧游标立即失效，终止本次排干；
                // 正在执行的单次模型调用照常完成，后续消息由新状态的
                // 下一次触发接管。
                if (this.stateByScope.get(key) !== state) {
                    runLogger.diagnosticSummary(() => ({
                        event: '记忆提取停止',
                        detail: `${formatLogScope(scope)}; 原因：会话状态已清除`
                    }))
                    return
                }
                const drainedMore = await this.drainNextChunk(
                    state,
                    scope,
                    options,
                    runLogger
                )
                if (!drainedMore) {
                    return
                }
            }
        } finally {
            this.runningScopeKeys.delete(key)
            const pending = this.stateByScope.get(key)
            if (pending && pending !== state && !pending.resolveInitialCursor) {
                this.schedule(key, pending)
            }
        }
    }

    /**
     * 排干下一块：无待处理块返回 false（本次排干结束）；成功提取、或连续
     * 失败达上限放弃并推进游标，返回 true（继续排后续块）；连续失败未达
     * 上限返回 false（中断本次，连同新消息下次重试）。
     */
    private async drainNextChunk(
        state: ExtractionScopeState,
        scope: MemoryScope,
        options: QueueExtractionOptions,
        runLogger: LivingMemoryLogger
    ): Promise<boolean> {
        const entries = this.messageLog.afterSeq(
            scope.conversationId,
            state.cursorSeq
        )
        if (
            options.includeOverheard &&
            entries.length < this.config.extractionWindowMessages
        ) {
            return false
        }
        const chunks = planExtractionChunks(
            entries,
            this.config.extractionWindowMessages,
            options.includeOverheard
        )
        const chunk = chunks[0]
        if (chunk == null) {
            return false
        }

        const messages = await toLogTranscriptMessages(
            scope,
            scope.platform ?? 'unknown',
            chunk
        )
        try {
            if (messages.length > 0) {
                await this.run(scope, messages, options, runLogger)
            } else {
                runLogger.diagnosticSummary(() => ({
                    event: '跳过记忆提取',
                    detail: `${formatLogScope(scope)}; 原因：本批消息转写为空`
                }))
            }
            state.cursorSeq = chunk[chunk.length - 1].seq
            state.failStreak = 0
            return true
        } catch (error) {
            return this.handleChunkFailure(
                state,
                scope,
                chunk,
                messages,
                error,
                runLogger
            )
        }
    }

    /**
     * 单块失败处理：连续失败未达上限时中断本次排干（返回 false），连同新
     * 消息下次重试；达到上限时记 failed job、推进游标放弃该块（返回 true）
     * 以续排后续块，防止游标永久卡死。
     */
    private async handleChunkFailure(
        state: ExtractionScopeState,
        scope: MemoryScope,
        chunk: readonly ConversationLogMessage[],
        messages: LivingMemoryTranscriptMessage[],
        error: unknown,
        runLogger: LivingMemoryLogger
    ): Promise<boolean> {
        state.failStreak += 1
        if (state.failStreak < EXTRACTION_FAIL_STREAK_LIMIT) {
            runLogger.summary(
                '记忆提取延期重试',
                (fields) =>
                    `${formatLogScope(fields)}; 连续失败：${state.failStreak} 次; 消息游标：${state.cursorSeq}`,
                'warn',
                error
            )
            return false
        }

        runLogger.summary(
            '记忆提取批次已跳过',
            (fields) =>
                `${formatLogScope(fields)}; 连续失败：${state.failStreak} 次; 消息范围：${state.cursorSeq + 1}—${chunk[chunk.length - 1].seq}`,
            'warn',
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
        return true
    }

    private async run(
        scope: MemoryScope,
        messages: LivingMemoryTranscriptMessage[],
        options: QueueExtractionOptions,
        logger: LivingMemoryLogger
    ) {
        const startedAt = new Date()
        const payload = this.formatter.toExtractionPayload(messages)
        const origin = await options.resolveTranscriptOrigin()
        const input = `${origin.header}\n\n${payload.input}`

        logger.diagnosticSummary(() => ({
            event: '开始记忆提取',
            detail: `${formatLogScope(scope)}; 本批消息：${payload.sourceOriginMessages.length} 条; 输入内容：${input.length} 字符`
        }))

        const presetPrompt = await this.presetPersona.resolveOrGenerateCardText(
            scope.presetId
        )
        const result = await this.extractor.extract(
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
        if (result.skippedReason != null) {
            logger.diagnosticSummary(() => ({
                event: '跳过记忆提取',
                detail: `${formatLogScope(scope)}; 原因：${result.skippedReason === 'model-not-configured' ? '提取模型未配置' : '提取模型暂不可用'}`
            }))
            return
        }

        // 结果工具在一次纠正重试后仍无法通过校验：持久化失败记录，
        // 使任务列表如实反映“结构化输出失败”而非“抽取 0 条”。
        if (result.parseError != null) {
            const parseError = result.parseError
            logger.summary(
                '记忆提取结果解析失败',
                (fields) => `${formatLogScope(fields)}; 原因：${parseError}`,
                'warn'
            )
            await this.recordFailedExtraction(
                scope,
                input,
                `extraction parse failed: ${parseError}`,
                startedAt
            )
            return
        }

        const extracted = result.extracted
        if (extracted.length > 0) {
            // 铸键不变量：窗口说话人随记忆一并提交，注册与追加在变更服务
            // 的同一预设级队列操作内完成（注册先行、两事务，依据见
            // appendExtractedMemories），否则 Dream 按 key 反查标签时会缺行。
            const saved = await this.memoryWriter.appendExtractedMemories(
                scope,
                payload.sourceOriginMessages,
                extracted,
                origin.sourceLabel,
                payload.speakers
            )
            for (const warning of saved.warnings) {
                logger.summary(
                    '记忆提取索引同步延期',
                    `${formatLogScope(scope)}; 原因：${warning}`,
                    'warn'
                )
            }
            this.queueIncrementalDream(
                scope.presetId,
                saved.memories.map((entry) => entry.id)
            )
        }

        logger.diagnosticSummary(() => ({
            event: '记忆提取完成',
            detail: `${formatLogScope(scope)}; 提取记忆：${extracted.length} 条`
        }))
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
