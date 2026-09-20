import assert from 'node:assert/strict'
import { Context, Logger, type Session } from 'koishi'
import { apply as applyCharacterMiddleware } from '../src/plugins/character_middleware'
import type { LivingMemoryConfig } from '../src/contracts/workflows'
import type { MemoryScope } from '../src/contracts/memory'
import { LivingMemoryLogger } from '../src/service/logging/logger'
import { MessageLogRegistry } from '../src/service/transcript/message_log/message_log_registry'
import { createTestContext } from './persistence-test-utils'

const setTestService = (ctx: Context, name: string, service: unknown) =>
    ctx.set(name, service)

const testConfig: LivingMemoryConfig = {
    enableConversationIsolation: false,
    enableSnapshotInjection: false,
    enableUserProfileInjection: false,
    recallStrategy: 'embedding-rerank',
    mainModel: 'test-model',
    subModel: 'test-model',
    enableAutoDream: false,
    autoDreamMemoryGrowthThreshold: 10,
    userProfileMinMemoryCount: 3,
    userProfileMemoryLimit: 5,
    enableRecallQueryRewrite: false,
    recallIntervalMessages: 1,
    recallHistoryMessages: 5,
    embeddingModel: 'test-model',
    rerankModel: 'test-model',
    extractionWindowMessages: 30,
    extractionIncludeOverheard: false,
    enableExtractionWhitelist: false,
    extractionWhitelist: [],
    recallTopK: 1,
    memorySearchToolMaxResults: 1,
    memorySearchMinSimilarity: 0,
    enableMemoryCreationTool: false,
    memoryCreateToolMaxMemories: 1,
    debug: false
}

it('clears extraction state when Character integration unloads', async () => {
    const ctx = createTestContext()
    let clearCalls = 0
    let clearRecallCalls = 0
    const chatluna = {
        promptRenderer: {
            registerFunctionProvider: () => () => true
        }
    } satisfies {
        promptRenderer: Pick<
            Context['chatluna']['promptRenderer'],
            'registerFunctionProvider'
        >
    }
    setTestService(ctx, 'chatluna', chatluna)
    const livingMemory = {
        memoryLogger: new LivingMemoryLogger(new Logger('test'), () => false),
        clearExtractionState: () => {
            clearCalls += 1
        },
        clearRecallState: () => {
            clearRecallCalls += 1
        }
    } satisfies Pick<
        Context['chatluna_living_memory'],
        'memoryLogger' | 'clearExtractionState' | 'clearRecallState'
    >
    setTestService(ctx, 'chatluna_living_memory', livingMemory)
    ctx.inject(
        ['chatluna', 'chatluna_living_memory', 'chatluna_character'],
        (injectedCtx) => {
            void applyCharacterMiddleware(injectedCtx, testConfig)
        }
    )

    await ctx.start()
    try {
        const disposeCharacter = setTestService(ctx, 'chatluna_character', {})
        disposeCharacter()

        assert.equal(clearCalls, 1)
        assert.equal(clearRecallCalls, 1)
    } finally {
        await ctx.stop()
    }
})

it('loads recall history from the conversation log excluding the current message', async () => {
    const ctx = createTestContext()
    const chatluna = {
        promptRenderer: { registerFunctionProvider: () => () => true }
    } satisfies {
        promptRenderer: Pick<
            Context['chatluna']['promptRenderer'],
            'registerFunctionProvider'
        >
    }
    ctx.set('chatluna', chatluna)

    const messageLog = new MessageLogRegistry()
    const captured: {
        scope?: MemoryScope
        currentContent?: string
        history?: string[]
    } = {}
    const scope: MemoryScope = {
        conversationId: 'group:guild-1',
        presetId: 'preset（Character）',
        presetLabel: 'preset',
        guildId: 'guild-1',
        isDirect: false,
        platform: 'onebot'
    }
    const livingMemory = {
        memoryLogger: new LivingMemoryLogger(new Logger('test'), () => false),
        messageLog,
        createScope: () => scope,
        recordPresetSpeaker: async () => {},
        queueRecall: async (
            recallScope: MemoryScope,
            currentMessage: { contentLines: string[] },
            loadHistory: () => Promise<{ contentLines: string[] }[]>
        ) => {
            captured.scope = recallScope
            captured.currentContent = currentMessage.contentLines.join('|')
            captured.history = (await loadHistory()).map((message) =>
                message.contentLines.join('|')
            )
        },
        queueExtraction: async () => {},
        clearExtractionState: () => {},
        clearRecallState: () => {}
    } satisfies Pick<
        Context['chatluna_living_memory'],
        | 'memoryLogger'
        | 'messageLog'
        | 'createScope'
        | 'recordPresetSpeaker'
        | 'queueRecall'
        | 'queueExtraction'
        | 'clearExtractionState'
        | 'clearRecallState'
    >
    ctx.set('chatluna_living_memory', livingMemory)

    // 预置日志：collector 通道视角的历史（含闲聊与旧回复），当前消息不在其中
    messageLog.register(
        'group:guild-1',
        { platform: 'onebot', channelId: 'guild-1', isDirect: false },
        { selfId: 'bot-self' }
    )
    await messageLog.warmup('group:guild-1')
    messageLog.appendLive(['group:guild-1'], {
        messageId: 'm-1',
        userId: 'user-1',
        name: '用户A',
        content: '之前的问题',
        timestamp: Date.now(),
        role: 'user',
        origin: 'live'
    })
    messageLog.appendReply('group:guild-1', [
        {
            messageId: 'm-2',
            userId: 'bot-self',
            name: 'bot',
            content: '之前的回答',
            timestamp: Date.now(),
            role: 'assistant',
            origin: 'reply'
        },
        {
            messageId: 'm-3',
            userId: 'user-2',
            name: '用户B',
            content: '旁听闲聊',
            timestamp: Date.now(),
            role: 'user',
            origin: 'live'
        }
    ])

    ctx.inject(
        ['chatluna', 'chatluna_living_memory', 'chatluna_character'],
        (injectedCtx) => {
            void applyCharacterMiddleware(injectedCtx, testConfig)
        }
    )

    await ctx.start()
    try {
        ctx.set('chatluna_character', {})
        const session = {
            platform: 'onebot',
            channelId: 'guild-1',
            guildId: 'guild-1',
            isDirect: false,
            userId: 'user-1',
            selfId: 'bot-self',
            username: '用户A',
            bot: {
                selfId: 'bot-self',
                user: { name: 'bot' },
                getUser: async () => ({ name: '用户A' })
            }
        } as unknown as Session
        const emitCharacterBeforeChat = ctx as unknown as {
            parallel: (name: string, payload: unknown) => Promise<void>
        }
        await emitCharacterBeforeChat.parallel(
            'chatluna_character/before-chat',
            {
                session,
                sessionKey: 'group:guild-1',
                presetName: 'preset',
                preset: { name: 'preset', system: {}, input: {} },
                messages: [
                    { id: 'user-1', name: '用户A', content: '之前的问题' },
                    { id: 'bot-self', name: 'bot', content: '之前的回答' },
                    { id: 'user-2', name: '用户B', content: '旁听闲聊' },
                    {
                        id: 'user-1',
                        name: '用户A',
                        content: '新的触发消息',
                        timestamp: Date.now()
                    }
                ],
                focusMessage: {
                    id: 'user-1',
                    name: '用户A',
                    content: '新的触发消息',
                    messageId: 'm-4',
                    timestamp: Date.now()
                }
            }
        )

        assert.equal(captured.scope, scope)
        assert.equal(captured.currentContent, '新的触发消息')
        // 历史来自日志（含旁听闲聊），当前消息被排除且只出现一次
        assert.deepEqual(captured.history, [
            '之前的问题',
            '之前的回答',
            '旁听闲聊'
        ])
    } finally {
        await ctx.stop()
    }
})

it('appends only the actually-sent Character reply run to the conversation log', async () => {
    const ctx = createTestContext()
    const chatluna = {
        promptRenderer: { registerFunctionProvider: () => () => true }
    } satisfies {
        promptRenderer: Pick<
            Context['chatluna']['promptRenderer'],
            'registerFunctionProvider'
        >
    }
    ctx.set('chatluna', chatluna)

    const messageLog = new MessageLogRegistry()
    const queuedScopes: MemoryScope[] = []
    const scope: MemoryScope = {
        conversationId: 'group:guild-1',
        presetId: 'preset（Character）',
        presetLabel: 'preset',
        guildId: 'guild-1',
        isDirect: false,
        platform: 'onebot'
    }
    const livingMemory = {
        memoryLogger: new LivingMemoryLogger(new Logger('test'), () => false),
        messageLog,
        createScope: () => scope,
        recordPresetSpeaker: async () => {},
        queueExtraction: async (queuedScope: MemoryScope) => {
            queuedScopes.push(queuedScope)
        },
        clearExtractionState: () => {},
        clearRecallState: () => {}
    } satisfies Pick<
        Context['chatluna_living_memory'],
        | 'memoryLogger'
        | 'messageLog'
        | 'createScope'
        | 'recordPresetSpeaker'
        | 'queueExtraction'
        | 'clearExtractionState'
        | 'clearRecallState'
    >
    ctx.set('chatluna_living_memory', livingMemory)

    ctx.inject(
        ['chatluna', 'chatluna_living_memory', 'chatluna_character'],
        (injectedCtx) => {
            void applyCharacterMiddleware(injectedCtx, testConfig)
        }
    )

    await ctx.start()
    try {
        ctx.set('chatluna_character', {})
        const session = {
            platform: 'onebot',
            channelId: 'guild-1',
            guildId: 'guild-1',
            isDirect: false,
            userId: 'user-1',
            selfId: 'bot-self',
            username: '用户A',
            bot: {
                selfId: 'bot-self',
                user: { name: 'bot' },
                getUser: async () => ({ name: '用户A' })
            }
        } as unknown as Session
        const emitCharacterAfterChat = ctx as unknown as {
            parallel: (name: string, payload: unknown) => Promise<void>
        }
        await emitCharacterAfterChat.parallel('chatluna_character/after-chat', {
            session,
            sessionKey: 'group:guild-1',
            presetName: 'preset',
            preset: { name: 'preset', system: {}, input: {} },
            messages: [
                {
                    id: 'user-1',
                    name: '用户A',
                    content: '新的触发消息',
                    messageId: 'm-4',
                    timestamp: 4
                },
                {
                    id: 'bot-self',
                    name: 'bot',
                    content: '回复第一段',
                    messageId: 'm-5',
                    timestamp: 5
                },
                {
                    id: 'bot-self',
                    name: 'bot',
                    content: '   ',
                    messageId: 'm-6',
                    timestamp: 6
                },
                {
                    id: 'user-2',
                    name: '用户B',
                    content: '回复之后的闲聊',
                    messageId: 'm-7',
                    timestamp: 7
                }
            ],
            focusMessage: {
                id: 'user-1',
                name: '用户A',
                content: '新的触发消息',
                messageId: 'm-4',
                timestamp: 4
            }
        })

        assert.deepEqual(queuedScopes, [scope])
        // 只追加实际发出的 bot 段：空回复与段外闲聊不产生条目
        const history = await messageLog.loadRecallHistory(
            'group:guild-1',
            10,
            null
        )
        assert.deepEqual(
            history.map((entry) => [entry.role, entry.content, entry.origin]),
            [['assistant', '回复第一段', 'reply']]
        )
    } finally {
        await ctx.stop()
    }
})
