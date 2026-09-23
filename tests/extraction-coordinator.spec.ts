import { describe, expect, it } from 'vitest'
import type {
    AttributedMemoryItem,
    ExtractionPayload
} from '../src/contracts/workflows'
import type { MemoryScope, MemorySourceMessage } from '../src/contracts/memory'
import {
    type ExtractionJobRepository,
    type ExtractionMemoryWriter,
    LivingMemoryExtractionCoordinator,
    planExtractionChunks
} from '../src/service/workflows/extraction/coordinator'
import { MessageLogRegistry } from '../src/service/transcript/message_log/message_log_registry'
import type { ConversationBackfillBot } from '../src/service/transcript/message_log/backfill'
import type { ConversationLogMessage } from '../src/service/transcript/message_log/types'
import type { LivingMemoryExtractionTrace } from '../src/service/workflows/extraction/extractor'
import {
    createCapturedLogger,
    createJobStore,
    scope as baseScope,
    waitFor
} from './workflow-test-utils'

const scope: MemoryScope = { ...baseScope, platform: 'onebot' }

const createExtractionTrace = (
    overrides: Partial<LivingMemoryExtractionTrace> = {}
): LivingMemoryExtractionTrace => ({
    extracted: [],
    prompt: null,
    output: null,
    skippedReason: null,
    parseError: null,
    ...overrides
})

const createExtractedMemory = (): AttributedMemoryItem => ({
    type: 'fact',
    content: 'memory',
    summary: 'memory summary',
    keywords: ['memory'],
    sentiment: 'neutral',
    importance: 0.5,
    speakerKeys: ['speaker-key']
})

interface CoordinatorHarnessOptions {
    window?: number
    includeOverheard?: boolean
    enableExtractionWhitelist?: boolean
    extractionWhitelist?: string[]
    backfillBot?: ConversationBackfillBot
    extractWithTrace?: () => Promise<LivingMemoryExtractionTrace>
    createFailedJob?: ExtractionJobRepository['createFailedJob']
    queueAutoDream?: (presetId: string) => void
    appendMemories?: ExtractionMemoryWriter['appendMemories']
}

interface CoordinatorHarness {
    coordinator: LivingMemoryExtractionCoordinator
    messageLog: MessageLogRegistry
    jobStore: ReturnType<typeof createJobStore>
    appended: {
        scope: MemoryScope
        sourceOriginMessages: MemorySourceMessage[]
        extracted: AttributedMemoryItem[]
        sourceLabel?: string | null
    }[]
    getExtractorCalls: () => number
    getExtractorInputs: () => string[]
    warnings: unknown[][]
}

const createHarness = (
    options: CoordinatorHarnessOptions = {}
): CoordinatorHarness => {
    const trace = options.extractWithTrace
    const jobStore = createJobStore()
    const appended: CoordinatorHarness['appended'] = []
    const captured = createCapturedLogger(false)
    let extractorCalls = 0
    const extractorInputs: string[] = []

    const formatter = {
        toExtractionPayload: ((
            messages: { contentLines: string[]; speakerLabel: string }[]
        ): ExtractionPayload => ({
            input: messages
                .map(
                    (message) =>
                        `${message.speakerLabel}: ${message.contentLines.join('|')}`
                )
                .join('\n'),
            sourceOriginMessages: messages.map((message) => ({
                role: 'user' as const,
                speakerLabel: message.speakerLabel,
                content: message.contentLines.join('|'),
                transcriptLines: [
                    `${message.speakerLabel}说：${message.contentLines.join('|')}`
                ]
            })),
            speakers: []
        })) as never
    }
    const extractor = {
        extractWithTrace: async (input: string) => {
            extractorCalls += 1
            extractorInputs.push(input)
            return await (trace?.() ?? Promise.resolve(createExtractionTrace()))
        }
    }
    const repository: ExtractionJobRepository & ExtractionMemoryWriter = {
        createFailedJob: options.createFailedJob ?? jobStore.createFailedJob,
        appendMemories:
            options.appendMemories ??
            (async (
                entryScope,
                sourceOriginMessages,
                extracted,
                sourceLabel
            ) => {
                appended.push({
                    scope: entryScope,
                    sourceOriginMessages,
                    extracted,
                    sourceLabel
                })
                return []
            })
    }
    const messageLog = new MessageLogRegistry()
    messageLog.register(
        scope.conversationId,
        {
            platform: 'onebot',
            channelId: 'channel-1',
            isDirect: false
        },
        options.backfillBot ?? { selfId: 'bot-self' }
    )

    const coordinator = new LivingMemoryExtractionCoordinator(
        {
            extractionWindowMessages: options.window ?? 4,
            extractionIncludeOverheard: options.includeOverheard ?? false,
            enableExtractionWhitelist:
                options.enableExtractionWhitelist ?? false,
            extractionWhitelist: options.extractionWhitelist ?? []
        },
        messageLog,
        repository,
        repository,
        formatter,
        extractor,
        options.queueAutoDream ?? (() => {}),
        captured.logger
    )
    return {
        coordinator,
        messageLog,
        jobStore,
        appended,
        getExtractorCalls: () => extractorCalls,
        getExtractorInputs: () => extractorInputs,
        warnings: captured.warnings
    }
}

const entry = (
    role: 'user' | 'assistant',
    content: string
): {
    userId: string
    name: string
    content: string
    timestamp: number
    role: 'user' | 'assistant'
    origin: 'live'
} => ({
    userId: role === 'assistant' ? 'bot-self' : 'user-1',
    name: role === 'assistant' ? 'bot' : '用户A',
    content,
    timestamp: Date.now(),
    role,
    origin: 'live'
})

const queueExtraction = async (
    harness: CoordinatorHarness,
    resolvePresetPrompt: () => Promise<string> = async () => '你是测试助手。'
) => {
    await harness.messageLog.warmup(scope.conversationId)
    await harness.coordinator.queue(scope, {
        resolvePresetPrompt,
        resolveTranscriptOrigin: async () => ({
            header: '以下是聊天记录：',
            sourceLabel: '来源于「测试群」（群聊 ID：guild-1）的群聊'
        })
    })
}

describe('planExtractionChunks', () => {
    const log = (roles: ('user' | 'assistant')[]): ConversationLogMessage[] =>
        roles.map((role, index) => ({
            seq: index + 1,
            userId: role === 'assistant' ? 'bot' : 'user',
            name: role,
            content: `${role}-${index}`,
            timestamp: 1_000,
            role,
            origin: 'live'
        }))

    it('closes segments at the last assistant of each run and leaves the unclosed tail', () => {
        // u u a a u a u（末尾无 assistant 收尾）
        const chunks = planExtractionChunks(
            log([
                'user',
                'user',
                'assistant',
                'assistant',
                'user',
                'assistant',
                'user'
            ]),
            10,
            false
        )
        expect(chunks.map((chunk) => chunk.length)).toEqual([6])
    })

    it('merges the exchange containing the window cut into one fuzzy chunk', () => {
        const chunks = planExtractionChunks(
            log(['user', 'assistant', 'user', 'assistant']),
            3,
            false
        )
        expect(chunks.map((chunk) => chunk.length)).toEqual([4])
        expect(chunks[0].map((e) => e.content)).toEqual([
            'user-0',
            'assistant-1',
            'user-2',
            'assistant-3'
        ])
    })

    it('keeps an overlong round whole as its own chunk without truncation', () => {
        const roles: ('user' | 'assistant')[] = Array(50).fill('user')
        roles.push('assistant')
        const chunks = planExtractionChunks(log(roles), 30, false)
        // 段长 51 超出预算 45：一轮（触发消息＋回复）不截断，整段独立成块
        expect(chunks).toHaveLength(1)
        expect(chunks[0]).toHaveLength(51)
        expect(chunks[0][50].role).toBe('assistant')
    })

    it('splits a long segment preferring assistant boundaries in overheard mode', () => {
        // 单段：4 用户 + 2 连续 assistant（段长 6 > 窗口 5）
        const chunks = planExtractionChunks(
            log(['user', 'user', 'user', 'user', 'assistant', 'assistant']),
            5,
            true
        )
        expect(chunks.map((chunk) => chunk.length)).toEqual([5, 1])
        expect(chunks[0][chunks[0].length - 1].role).toBe('assistant')
    })

    it('splits pure-chatter stretches at the window in overheard mode', () => {
        // 单段：7 用户 + 1 assistant（窗口内无 assistant 时按窗口切）
        const chunks = planExtractionChunks(
            log([
                'user',
                'user',
                'user',
                'user',
                'user',
                'user',
                'user',
                'assistant'
            ]),
            3,
            true
        )
        expect(chunks.map((chunk) => chunk.length)).toEqual([3, 3, 2])
        expect(chunks[chunks.length - 1][1].role).toBe('assistant')
    })
})

describe('LivingMemoryExtractionCoordinator', () => {
    it('extracts once the backlog reaches the window', async () => {
        const harness = createHarness({ window: 4 })
        // 首个 after-chat 初始化游标（空日志末尾）
        await queueExtraction(harness)

        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', '问题'),
            entry('assistant', '回答')
        ])
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(0)

        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', '追问'),
            entry('assistant', '补充')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'drain settle')
        expect(harness.getExtractorInputs()[0]).toContain('问题')
        expect(harness.getExtractorInputs()[0]).toContain('补充')
    })

    it('skips extraction entirely when the window is zero', async () => {
        const harness = createHarness({ window: 0 })
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'a'),
            entry('assistant', 'b')
        ])
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(0)
    })

    it('initializes the cold cursor at the current tail without dumping history', async () => {
        const harness = createHarness({ window: 2 })
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', '旧消息'),
            entry('assistant', '旧回答')
        ])
        // 首个 after-chat：游标落在当时末尾，不回溯提取
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(0)

        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', '新消息'),
            entry('assistant', '新回答')
        ])
        await queueExtraction(harness)
        await waitFor(
            () => harness.getExtractorCalls() === 1,
            'post-init drain'
        )
        expect(harness.getExtractorInputs()[0]).not.toContain('旧消息')
    })

    it('leaves an assistant-less tail unconsumed for the next drain', async () => {
        const harness = createHarness({ window: 2 })
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', '问题'),
            entry('assistant', '回答'),
            entry('user', '只有闲聊')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'drain segment')
        expect(harness.getExtractorInputs()[0]).toContain('问题')
        expect(harness.getExtractorInputs()[0]).not.toContain('只有闲聊')

        // 追加闲聊不闭合段：不消费
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', '更多闲聊')
        ])
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(1)
    })

    it('absorbs a sub-half-window overshoot into one fuzzy chunk', async () => {
        const harness = createHarness({ window: 4 })
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q1'),
            entry('assistant', 'a1'),
            entry('user', 'q2'),
            entry('assistant', 'a2'),
            entry('user', 'q3'),
            entry('assistant', 'a3')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'fuzzy chunk')
        // 三段共 6 条 > 窗口 4，但盈余 2 ≤ 半窗 2：并入同块，最新交换带上下文
        expect(harness.getExtractorInputs()[0]).toContain('q1')
        expect(harness.getExtractorInputs()[0]).toContain('q3')
    })

    it('splits whole-exchange chunks only when the remainder exceeds half the window', async () => {
        const harness = createHarness({ window: 2 })
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q1'),
            entry('assistant', 'a1'),
            entry('user', 'q2'),
            entry('assistant', 'a2'),
            entry('user', 'q3'),
            entry('assistant', 'a3')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 3, 'three chunks')
        // 窗口 2、半窗 1：每段 2 条，盈余 2 > 1 才允许独立成块，段不腰斩
        expect(harness.getExtractorInputs()[0]).toContain('q1')
        expect(harness.getExtractorInputs()[2]).toContain('q3')
    })

    it('retries a failing chunk and abandons it after three failures', async () => {
        let modelCalls = 0
        const harness = createHarness({
            window: 2,
            extractWithTrace: () => {
                modelCalls += 1
                if (modelCalls <= 3) {
                    return Promise.reject(new Error('model down'))
                }
                return Promise.resolve(createExtractionTrace())
            }
        })
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q1'),
            entry('assistant', 'a1'),
            entry('user', 'q2'),
            entry('assistant', 'a2')
        ])

        // 连续两次失败：游标不动，不记任务
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'first failure')
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 2, 'second failure')
        expect(harness.jobStore.jobs).toHaveLength(0)

        // 第三次失败达到上限：块 1 记任务放弃，同次排干继续块 2 并成功
        await queueExtraction(harness)
        await waitFor(
            () => harness.getExtractorCalls() === 4,
            'abandon and next'
        )
        expect(harness.jobStore.jobs).toHaveLength(1)
        expect(harness.getExtractorInputs()[0]).toContain('q1')
        expect(harness.getExtractorInputs()[3]).toContain('q2')
    })

    it('does not initialize the cursor for non-whitelisted scopes', async () => {
        const whitelistedScope: MemoryScope = {
            ...scope,
            guildId: 'guild-1'
        }
        const harness = createHarness({
            window: 2,
            enableExtractionWhitelist: true,
            extractionWhitelist: ['guild-1']
        })
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])

        // 未命中白名单：跳过且游标不初始化
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(0)

        // 命中白名单后的首个事件：从当时刻起算，不倾泻之前的积压
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q2'),
            entry('assistant', 'a2')
        ])
        await harness.messageLog.warmup(whitelistedScope.conversationId)
        await harness.coordinator.queue(whitelistedScope, {
            resolvePresetPrompt: async () => 'preset',
            resolveTranscriptOrigin: async () => ({
                header: 'h',
                sourceLabel: 's'
            })
        })
        expect(harness.getExtractorCalls()).toBe(0)

        harness.messageLog.appendReply(whitelistedScope.conversationId, [
            entry('user', 'q3'),
            entry('assistant', 'a3')
        ])
        await harness.coordinator.queue(whitelistedScope, {
            resolvePresetPrompt: async () => 'preset',
            resolveTranscriptOrigin: async () => ({
                header: 'h',
                sourceLabel: 's'
            })
        })
        await waitFor(
            () => harness.getExtractorCalls() === 1,
            'whitelisted drain'
        )
        expect(harness.getExtractorInputs()[0]).toContain('q3')
    })

    it('writes extracted memories and queues auto dream', async () => {
        const dreamPresetIds: string[] = []
        const trace = createExtractionTrace({
            extracted: [createExtractedMemory()]
        })
        const harness = createHarness({
            window: 2,
            extractWithTrace: () => Promise.resolve(trace),
            queueAutoDream: (presetId) => dreamPresetIds.push(presetId)
        })
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)

        await waitFor(() => harness.appended.length === 1, 'memory written')
        expect(harness.appended[0].extracted).toHaveLength(1)
        expect(dreamPresetIds).toEqual([scope.presetId])
        expect(harness.jobStore.jobs).toHaveLength(0)
    })

    it('records a failed job and consumes the chunk on parse errors', async () => {
        const harness = createHarness({
            window: 2,
            extractWithTrace: () =>
                Promise.resolve(
                    createExtractionTrace({ parseError: 'bad output' })
                )
        })
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.jobStore.jobs.length === 1, 'parse job')
        expect(harness.getExtractorCalls()).toBe(1)

        // 解析失败视为该块已消费，不重试
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(1)
    })

    it('clears scope state by conversation', async () => {
        const harness = createHarness({ window: 2 })
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(0)

        harness.coordinator.clearByConversation(scope.conversationId)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q2'),
            entry('assistant', 'a2')
        ])
        await queueExtraction(harness)
        // 清空后游标重置为当前末尾，重新起算
        expect(harness.getExtractorCalls()).toBe(0)
    })

    it('defers cursor initialization until backfill succeeds', async () => {
        let failBackfill = true
        const backfillBot: ConversationBackfillBot = {
            selfId: 'bot-self',
            getMessageList: async () => {
                if (failBackfill) {
                    throw new Error('platform down')
                }
                return {
                    data: [
                        {
                            id: 'old-1',
                            user: { id: 'user-1', name: '用户A' },
                            content: '回填历史',
                            timestamp: 1_000
                        }
                    ]
                }
            }
        }
        const harness = createHarness({ window: 2, backfillBot })

        // 回填失败期间不初始化游标：积压已达标也不提取
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', '旧问题'),
            entry('assistant', '旧回答')
        ])
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(0)

        // 重试成功：游标在回填落地后初始化，历史与新消息都不倾泻
        failBackfill = false
        await queueExtraction(harness)
        expect(harness.getExtractorCalls()).toBe(0)

        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q2'),
            entry('assistant', 'a2')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'drain')
        expect(harness.getExtractorInputs()[0]).toContain('q2')
        expect(harness.getExtractorInputs()[0]).not.toContain('回填历史')
        expect(harness.getExtractorInputs()[0]).not.toContain('旧问题')
    })

    it('stops a running drain whose scope state was cleared mid-run', async () => {
        let releaseExtractor!: () => void
        const extractorGate = new Promise<void>((resolve) => {
            releaseExtractor = resolve
        })
        const harness = createHarness({
            window: 2,
            extractWithTrace: async () => {
                await extractorGate
                return createExtractionTrace()
            }
        })
        await queueExtraction(harness)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'q'),
            entry('assistant', 'a')
        ])
        await queueExtraction(harness)
        await waitFor(() => harness.getExtractorCalls() === 1, 'drain gated')

        // 模型请求等待期间清空会话，随后新消息到达并由新状态接管
        harness.coordinator.clearByConversation(scope.conversationId)
        harness.messageLog.appendReply(scope.conversationId, [
            entry('user', 'new-q'),
            entry('assistant', 'new-a')
        ])
        releaseExtractor()
        await new Promise((resolve) => setTimeout(resolve, 20))

        // 旧排干只完成在途块，不再消费新纪元消息
        expect(harness.getExtractorCalls()).toBe(1)
        expect(harness.getExtractorInputs()[0]).toContain('q')
        expect(harness.getExtractorInputs()[0]).not.toContain('new-q')
    })
})
