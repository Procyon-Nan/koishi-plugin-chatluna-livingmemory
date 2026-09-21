import { describe, expect, it } from 'vitest'
import { apply } from '../src/plugins/message_collector'
import { MessageLogRegistry } from '../src/service/transcript/message_log/message_log_registry'

interface CollectorHarness {
    registry: MessageLogRegistry
    dispatch: (session: Record<string, unknown>) => Promise<void>
}

const createHarness = () => {
    const registry = new MessageLogRegistry()
    registry.register(
        'conv-1',
        { platform: 'onebot', channelId: 'group-1', isDirect: false },
        { selfId: 'bot-self' }
    )
    let middleware: ((session: never, next: () => void) => unknown) | null =
        null
    const ctx = {
        chatluna_living_memory: { messageLog: registry },
        middleware: (fn: (session: never, next: () => void) => unknown) => {
            middleware = fn
        }
    }
    apply(ctx as never)
    const ready = registry.warmup('conv-1')
    return {
        registry,
        dispatch: async (session: Record<string, unknown>) => {
            await ready
            if (middleware == null) {
                throw new Error('collector middleware was not registered')
            }
            let continued = false
            const result = middleware(session as never, () => {
                continued = true
            })
            await result
            expect(continued).toBe(true)
        }
    } satisfies CollectorHarness
}

const textElement = (content: string) => ({
    type: 'text',
    attrs: { content }
})

const baseSession = (overrides: Record<string, unknown> = {}) => ({
    platform: 'onebot',
    channelId: 'group-1',
    userId: 'user-1',
    selfId: 'bot-self',
    elements: [textElement('hello')],
    event: { timestamp: 1_000 },
    ...overrides
})

describe('message collector', () => {
    it('records a bound-channel user message', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(
            baseSession({
                messageId: 'm-1',
                username: '群名片',
                event: {
                    timestamp: 1_000,
                    user: { id: 'user-1', name: '用户A' },
                    member: { name: '群名片', nick: '群名片' }
                }
            })
        )

        const entries = registry.lastN('conv-1', 10)
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            messageId: 'm-1',
            userId: 'user-1',
            name: '用户A',
            content: 'hello',
            role: 'user',
            origin: 'live'
        })
    })

    it('skips unregistered channels with zero writes', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(baseSession({ channelId: 'other-group' }))
        expect(registry.lastN('conv-1', 10)).toEqual([])
    })

    it('skips own bot messages and command sessions', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(baseSession({ userId: 'bot-self' }))
        await dispatch(baseSession({ argv: { command: { name: 'help' } } }))
        expect(registry.lastN('conv-1', 10)).toEqual([])
    })

    it('skips empty content and falls back to the user id without a nickname', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(baseSession({ elements: [textElement('   ')] }))
        await dispatch(baseSession({ messageId: 'm-2' }))
        const entries = registry.lastN('conv-1', 10)
        expect(entries).toHaveLength(1)
        expect(entries[0].name).toBe('user-1')
    })

    it('replaces non-text elements with placeholders and warms the at nickname in the background', async () => {
        const { registry, dispatch } = createHarness()
        const bot = {
            getUser: async () => ({ name: '用户昵称B' })
        }
        // 冷缓存先记 @id（不等待查询，保住入账顺序），后台预热后同目标才渲染昵称
        await dispatch(
            baseSession({
                messageId: 'm-3',
                bot,
                elements: [
                    textElement('看这个'),
                    // name 是群名片口径，采集不得采信
                    { type: 'at', attrs: { id: 'user-2', name: '群名片B' } },
                    { type: 'at', attrs: { type: 'all' } },
                    {
                        type: 'img',
                        attrs: { src: 'https://example.test/a.jpg' }
                    },
                    {
                        type: 'forward',
                        attrs: { id: '7688043919364654622' }
                    }
                ]
            })
        )
        expect(registry.lastN('conv-1', 10)[0]?.content).toBe(
            '看这个@user-2@全体成员[图片][聊天记录]'
        )

        await new Promise((resolve) => setTimeout(resolve, 0))
        await dispatch(
            baseSession({
                messageId: 'm-6',
                bot,
                elements: [
                    textElement('再喊'),
                    { type: 'at', attrs: { id: 'user-2' } }
                ]
            })
        )
        expect(registry.lastN('conv-1', 10)[1]?.content).toBe('再喊@用户昵称B')
    })

    it('keeps pure forward messages as a placeholder entry', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(
            baseSession({
                messageId: 'm-4',
                elements: [{ type: 'forward', attrs: { id: '7688' } }]
            })
        )

        const entries = registry.lastN('conv-1', 10)
        expect(entries).toHaveLength(1)
        expect(entries[0].content).toBe('[聊天记录]')
    })

    it('falls back to the at id when the user lookup fails', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(
            baseSession({
                messageId: 'm-5',
                bot: {
                    getUser: async () => {
                        throw new Error('platform down')
                    }
                },
                elements: [
                    textElement('喊人'),
                    { type: 'at', attrs: { id: 'user-2' } }
                ]
            })
        )

        expect(registry.lastN('conv-1', 10)[0]?.content).toBe('喊人@user-2')
    })

    it('appends in arrival order when an at message is followed by a plain one', async () => {
        const { registry, dispatch } = createHarness()
        // getUser 永不完成：带 at 的消息不得因昵称解析让出而落到后到消息之后
        const first = dispatch(
            baseSession({
                messageId: 'm-a',
                bot: { getUser: () => new Promise<never>(() => {}) },
                elements: [
                    textElement('带'),
                    { type: 'at', attrs: { id: 'user-2' } }
                ]
            })
        )
        const second = dispatch(
            baseSession({
                messageId: 'm-b',
                elements: [textElement('普通')]
            })
        )
        await Promise.all([first, second])

        expect(
            registry.lastN('conv-1', 10).map((entry) => entry.messageId)
        ).toEqual(['m-a', 'm-b'])
        expect(
            registry.lastN('conv-1', 10).map((entry) => entry.content)
        ).toEqual(['带@user-2', '普通'])
    })
})
