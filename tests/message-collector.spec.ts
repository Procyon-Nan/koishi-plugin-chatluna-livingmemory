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
            void result
            expect(continued).toBe(true)
        }
    } satisfies CollectorHarness
}

const baseSession = (overrides: Record<string, unknown> = {}) => ({
    platform: 'onebot',
    channelId: 'group-1',
    userId: 'user-1',
    selfId: 'bot-self',
    username: '用户A',
    content: 'hello',
    event: { timestamp: 1_000 },
    ...overrides
})

describe('message collector', () => {
    it('records a bound-channel user message', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(
            baseSession({
                messageId: 'm-1',
                author: { nick: '群名片', name: '用户A' }
            })
        )

        const entries = registry.lastN('conv-1', 10)
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            messageId: 'm-1',
            userId: 'user-1',
            name: '群名片',
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

    it('skips empty content and falls back through name sources', async () => {
        const { registry, dispatch } = createHarness()
        await dispatch(baseSession({ content: '   ' }))
        await dispatch(baseSession({ username: undefined }))
        const entries = registry.lastN('conv-1', 10)
        expect(entries).toHaveLength(1)
        expect(entries[0].name).toBe('user-1')
    })
})
