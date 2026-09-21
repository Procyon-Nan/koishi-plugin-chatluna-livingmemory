import { describe, expect, it } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import type { Session } from 'koishi'
import { buildChatLunaSourceEntry } from '../src/plugins/chat_middleware'

const createSession = (overrides: Record<string, unknown> = {}) =>
    ({
        messageId: 'plat-1',
        userId: 'user-1',
        username: '用户A',
        ...overrides
    }) as unknown as Session

describe('buildChatLunaSourceEntry', () => {
    it('passes the platform messageId through for cross-channel dedup', () => {
        const entry = buildChatLunaSourceEntry(
            createSession(),
            new HumanMessage('你好')
        )

        expect(entry?.messageId).toBe('plat-1')
        expect(entry?.userId).toBe('user-1')
        expect(entry?.role).toBe('user')
        expect(entry?.origin).toBe('live')
    })

    it('omits messageId when the session carries none', () => {
        const entry = buildChatLunaSourceEntry(
            createSession({ messageId: undefined }),
            new HumanMessage('你好')
        )

        expect(entry?.messageId).toBeUndefined()
    })

    it('uses the user nickname over the group card for the speaker label', () => {
        const entry = buildChatLunaSourceEntry(
            createSession({
                username: '群名片A',
                event: {
                    user: { id: 'user-1', name: '用户昵称A' },
                    member: { name: '群名片A', nick: '群名片A' }
                }
            }),
            new HumanMessage('你好')
        )

        expect(entry?.name).toBe('用户昵称A')
    })

    it('returns null for empty content', () => {
        expect(
            buildChatLunaSourceEntry(createSession(), new HumanMessage('   '))
        ).toBeNull()
    })
})
