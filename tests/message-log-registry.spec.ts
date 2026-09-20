import { describe, expect, it } from 'vitest'
import { h } from 'koishi'
import { MessageLogRegistry } from '../src/service/transcript/message_log/message_log_registry'
import type {
    BackfillHistoryMessage,
    ConversationBackfillBot
} from '../src/service/transcript/message_log/backfill'

interface DeferredBackfill {
    bot: ConversationBackfillBot
    resolve: (messages: BackfillHistoryMessage[]) => void
    reject: (error: Error) => void
}

const createDeferredBackfillBot = (selfId = 'bot-self'): DeferredBackfill => {
    let resolve!: (messages: BackfillHistoryMessage[]) => void
    let reject!: (error: Error) => void
    const promise = new Promise<BackfillHistoryMessage[]>((res, rej) => {
        resolve = res
        reject = rej
    })
    const bot: ConversationBackfillBot = {
        selfId,
        getMessageList: async () => ({ data: await promise })
    }
    return { bot, resolve, reject }
}

const historyMessage = (
    id: string,
    userId: string,
    content: string
): BackfillHistoryMessage => ({
    id,
    user: { id: userId, name: `用户${userId}` },
    content,
    timestamp: 1_000
})

describe('MessageLogRegistry', () => {
    it('dispatches live appends to every conversation bound to the channel', async () => {
        const registry = new MessageLogRegistry()
        const { bot, resolve } = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), bot)
        registry.register('conv-2', channelBinding(), bot)
        resolve([])
        await registry.warmup('conv-1')
        await registry.warmup('conv-2')

        registry.appendLive(['conv-1', 'conv-2'], liveEntry('m-1', 'hello'))

        expect(registry.lastN('conv-1', 10).map((e) => e.content)).toEqual([
            'hello'
        ])
        expect(registry.lastN('conv-2', 10).map((e) => e.content)).toEqual([
            'hello'
        ])
    })

    it('is idempotent on repeated registration', async () => {
        const registry = new MessageLogRegistry()
        const first = createDeferredBackfillBot()
        const second = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), first.bot)
        registry.register('conv-1', channelBinding(), second.bot)
        first.resolve([historyMessage('h-1', 'user-1', 'old')])
        await registry.warmup('conv-1')

        expect(registry.lastN('conv-1', 10).map((e) => e.messageId)).toEqual([
            'h-1'
        ])
    })

    it('buffers live appends during backfill and flushes backfill first', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), deferred.bot)

        registry.appendLive(['conv-1'], liveEntry('live-1', 'live'))
        expect(registry.lastN('conv-1', 10)).toEqual([])

        deferred.resolve([historyMessage('h-1', 'user-1', 'old')])
        await registry.warmup('conv-1')

        expect(registry.lastN('conv-1', 10).map((e) => e.messageId)).toEqual([
            'h-1',
            'live-1'
        ])
    })

    it('warmup never rejects and retries backfill after a failure', async () => {
        const registry = new MessageLogRegistry()
        let attempts = 0
        const bot: ConversationBackfillBot = {
            selfId: 'bot-self',
            getMessageList: async () => {
                attempts += 1
                if (attempts === 1) {
                    throw new Error('platform down')
                }
                return {
                    data: [
                        {
                            user: { id: 'user-1', name: '用户user-1' },
                            content: 'old',
                            timestamp: 1000
                        }
                    ]
                }
            }
        }
        registry.register('conv-1', channelBinding(), bot)
        await expect(registry.warmup('conv-1')).resolves.toBeUndefined()
        expect(attempts).toBe(1)

        // 失败后写入直通，下一次 warmup 重新尝试回填
        registry.appendLive(['conv-1'], liveEntry('live-1', 'live'))
        expect(registry.lastN('conv-1', 10).map((e) => e.content)).toEqual([
            'live'
        ])
        await registry.warmup('conv-1')
        expect(attempts).toBe(2)
        // 重试回填晚于失败期间的直写到达：seq 按到达序，不按时间重排
        expect(registry.lastN('conv-1', 10).map((e) => e.content)).toEqual([
            'live',
            'old'
        ])
    })

    it('clear keeps the binding so live listening continues', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), deferred.bot)
        deferred.resolve([])
        await registry.warmup('conv-1')

        registry.appendLive(['conv-1'], liveEntry('live-1', 'a'))
        registry.clear('conv-1')
        expect(registry.lastN('conv-1', 10)).toEqual([])

        registry.appendLive(
            ['conv-1'],
            liveEntry('live-2', 'b', Date.now() + 10_000)
        )
        expect(registry.lastN('conv-1', 10).map((e) => e.messageId)).toEqual([
            'live-2'
        ])
    })

    it('ignores appends and reads for unregistered conversations', () => {
        const registry = new MessageLogRegistry()
        registry.appendLive(['conv-x'], liveEntry('m-1', 'a'))
        expect(registry.lastN('conv-x', 10)).toEqual([])
        expect(registry.tailSeq('conv-x')).toBeNull()
        expect(registry.countSince('conv-x', 0)).toBe(0)
    })

    it('backfill skips messages without timestamps and paginates by prev cursor', async () => {
        const registry = new MessageLogRegistry()
        const pages: BackfillHistoryMessage[][] = [
            [
                historyMessage('old-1', 'user-1', 'older'),
                historyMessage('new-1', 'user-1', 'newer')
            ],
            [historyMessage('page2', 'user-2', 'second')]
        ]
        const requestedCursors: Array<string | undefined> = []
        const bot: ConversationBackfillBot = {
            selfId: 'bot-self',
            getMessageList: async (_channelId, before) => {
                requestedCursors.push(before)
                const page = pages.shift() ?? []
                return {
                    data: page,
                    prev: page.length > 0 ? `${page[0]!.id}!` : undefined
                }
            }
        }

        registry.register('conv-1', channelBinding(), bot)
        await registry.warmup('conv-1')

        expect(requestedCursors).toEqual([undefined, 'old-1!', 'page2!'])
        expect(registry.lastN('conv-1', 10).map((e) => e.messageId)).toEqual([
            'page2',
            'old-1',
            'new-1'
        ])
    })

    it('marks backfill bot messages as assistant', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), deferred.bot)
        deferred.resolve([
            historyMessage('h-1', 'bot-self', 'bot said'),
            historyMessage('h-2', 'user-1', 'user said')
        ])
        await registry.warmup('conv-1')

        const roles = Object.fromEntries(
            registry.lastN('conv-1', 10).map((e) => [e.content, e.role])
        )
        expect(roles).toEqual({
            'bot said': 'assistant',
            'user said': 'user'
        })
    })

    it('backfill degrades to empty without getMessageList support', async () => {
        const registry = new MessageLogRegistry()
        registry.register('conv-1', channelBinding(), { selfId: 'bot-self' })
        await expect(registry.warmup('conv-1')).resolves.toBeUndefined()
        expect(registry.lastN('conv-1', 10)).toEqual([])
    })

    it('extracts backfill text from standard elements (attrs.content)', async () => {
        const registry = new MessageLogRegistry()
        const bot: ConversationBackfillBot = {
            selfId: 'bot-self',
            getMessageList: async () => ({
                data: [
                    {
                        id: 'e-1',
                        user: { id: 'user-1', name: '用户A' },
                        elements: [h.text('平台'), h.text('历史文本')],
                        timestamp: 1_000
                    }
                ]
            })
        }
        registry.register('conv-1', channelBinding(), bot)
        await registry.warmup('conv-1')

        expect(registry.lastN('conv-1', 10).map((e) => e.content)).toEqual([
            '平台历史文本'
        ])
    })

    it('paginates by the next cursor for Milky-shaped adapters', async () => {
        const registry = new MessageLogRegistry()
        const requestedCursors: Array<string | undefined> = []
        const pages: BackfillHistoryMessage[][] = [
            [historyMessage('new-1', 'user-1', 'newer')],
            [historyMessage('old-1', 'user-1', 'older')]
        ]
        const bot: ConversationBackfillBot = {
            selfId: 'bot-self',
            getMessageList: async (_channelId, before) => {
                requestedCursors.push(before)
                const page = pages.shift() ?? []
                return {
                    data: page,
                    next: page.length > 0 ? `${page[0]!.id}!` : undefined
                }
            }
        }
        registry.register('conv-1', channelBinding(), bot)
        await registry.warmup('conv-1')

        expect(requestedCursors).toEqual([undefined, 'new-1!', 'old-1!'])
        expect(registry.lastN('conv-1', 10).map((e) => e.messageId)).toEqual([
            'old-1',
            'new-1'
        ])
    })

    it('reports warm only after backfill succeeds', async () => {
        const registry = new MessageLogRegistry()
        let fail = true
        const bot: ConversationBackfillBot = {
            selfId: 'bot-self',
            getMessageList: async () => {
                if (fail) {
                    throw new Error('platform down')
                }
                return { data: [] }
            }
        }
        registry.register('conv-1', channelBinding(), bot)
        expect(registry.isWarm('conv-1')).toBe(false)
        await registry.warmup('conv-1')
        expect(registry.isWarm('conv-1')).toBe(false)

        fail = false
        await registry.warmup('conv-1')
        expect(registry.isWarm('conv-1')).toBe(true)
    })

    it('bounds recall history before the current message even when chatter follows', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), deferred.bot)
        deferred.resolve([])
        await registry.warmup('conv-1')

        registry.appendLive(['conv-1'], liveEntry('h-1', '旧消息', 1_000))
        registry.appendLive(['conv-1'], liveEntry('cur-1', '当前消息', 2_000))
        registry.appendLive(['conv-1'], liveEntry('later-1', '后续闲聊', 3_000))

        const history = await registry.loadRecallHistory('conv-1', 5, {
            messageId: 'cur-1',
            userId: 'user-1',
            content: '当前消息',
            timestamp: 2_000
        })
        expect(history.map((e) => e.messageId)).toEqual(['h-1'])
    })

    it('limits recall history to the count entries before the current message', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), deferred.bot)
        deferred.resolve([])
        await registry.warmup('conv-1')

        registry.appendLive(['conv-1'], liveEntry('h-1', '一', 1_000))
        registry.appendLive(['conv-1'], liveEntry('h-2', '二', 2_000))
        registry.appendLive(['conv-1'], liveEntry('h-3', '三', 3_000))
        registry.appendLive(['conv-1'], liveEntry('cur-1', '当前消息', 4_000))

        const history = await registry.loadRecallHistory('conv-1', 2, {
            messageId: 'cur-1',
            userId: 'user-1',
            content: '当前消息',
            timestamp: 4_000
        })
        expect(history.map((e) => e.messageId)).toEqual(['h-2', 'h-3'])
    })

    it('prefers explicit message ids over the fallback triple when both sides carry ids', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), deferred.bot)
        deferred.resolve([])
        await registry.warmup('conv-1')

        // 同用户同秒同内容的两条消息：写入侧按不同 messageId 保留两条，
        // 读取侧不得让后发消息的三元组冒充当前消息边界
        const shared = {
            userId: 'user-1',
            name: '用户A',
            content: '重复内容',
            timestamp: 3_000,
            role: 'user' as const,
            origin: 'live' as const
        }
        registry.appendLive(['conv-1'], { ...shared, messageId: 'a' })
        registry.appendLive(['conv-1'], { ...shared, messageId: 'b' })

        const history = await registry.loadRecallHistory('conv-1', 5, {
            messageId: 'a',
            userId: 'user-1',
            content: '重复内容',
            timestamp: 3_000
        })
        expect(history.map((e) => e.messageId)).toEqual([])
    })

    it('falls back to the latest entries when the current message is absent', async () => {
        const registry = new MessageLogRegistry()
        const deferred = createDeferredBackfillBot()
        registry.register('conv-1', channelBinding(), deferred.bot)
        deferred.resolve([])
        await registry.warmup('conv-1')

        registry.appendLive(['conv-1'], liveEntry('h-1', '一', 1_000))
        registry.appendLive(['conv-1'], liveEntry('h-2', '二', 2_000))

        const history = await registry.loadRecallHistory('conv-1', 5, {
            messageId: 'missing',
            userId: 'user-1',
            content: '不在日志',
            timestamp: 9_000
        })
        expect(history.map((e) => e.messageId)).toEqual(['h-1', 'h-2'])
    })
})

const channelBinding = () => ({
    platform: 'onebot',
    channelId: 'group-1',
    isDirect: false
})

const liveEntry = (messageId: string, content: string, timestamp = 2_000) => ({
    messageId,
    userId: 'user-1',
    name: '用户A',
    content,
    timestamp,
    role: 'user' as const,
    origin: 'live' as const
})
