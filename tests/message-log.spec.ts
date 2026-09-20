import { describe, expect, it } from 'vitest'
import { ConversationMessageLog } from '../src/service/transcript/message_log/message_log'
import type { ConversationLogEntryInput } from '../src/service/transcript/message_log/types'

const entry = (overrides: Partial<ConversationLogEntryInput> = {}) => {
    return {
        userId: 'user-1',
        name: '用户A',
        content: 'hello',
        role: 'user',
        origin: 'live',
        ...overrides
    } satisfies ConversationLogEntryInput
}

describe('ConversationMessageLog', () => {
    it('assigns monotonic seq and reads lastN/afterSeq/tailSeq', () => {
        const log = new ConversationMessageLog(10)
        log.append([entry({ content: 'a' }), entry({ content: 'b' })])
        log.append([entry({ content: 'c' })])

        expect(log.tailSeq()).toBe(3)
        expect(log.lastN(2).map((item) => item.content)).toEqual(['b', 'c'])
        expect(log.afterSeq(1).map((item) => item.content)).toEqual(['b', 'c'])
        expect(log.lastN(0)).toEqual([])
    })

    it('dedupes by messageId across channels', () => {
        const log = new ConversationMessageLog(10)
        log.append([
            entry({ messageId: 'm-1', content: 'a', origin: 'live' }),
            entry({ messageId: 'm-1', content: 'a', origin: 'backfill' })
        ])

        expect(log.lastN(10)).toHaveLength(1)
        expect(log.lastN(10)[0].origin).toBe('live')
    })

    it('dedupes by fallback key when messageId is missing', () => {
        const log = new ConversationMessageLog(10)
        log.append([
            entry({ content: 'a', timestamp: 1000 }),
            entry({ content: 'a', timestamp: 1000 })
        ])

        expect(log.lastN(10)).toHaveLength(1)
    })

    it('keeps distinct messages sharing a fallback triple apart by messageId', () => {
        const log = new ConversationMessageLog(10)
        log.append([
            entry({ messageId: 'm-1', content: 'a', timestamp: 1000 }),
            entry({ messageId: 'm-2', content: 'a', timestamp: 1000 })
        ])

        expect(log.lastN(10)).toHaveLength(2)
    })

    it('evicts oldest beyond capacity while seq stays monotonic', () => {
        const log = new ConversationMessageLog(3)
        log.append([
            entry({ messageId: 'm-1', content: 'a' }),
            entry({ messageId: 'm-2', content: 'b' }),
            entry({ messageId: 'm-3', content: 'c' })
        ])
        log.append([entry({ messageId: 'm-4', content: 'd' })])

        expect(log.lastN(10).map((item) => item.content)).toEqual([
            'b',
            'c',
            'd'
        ])
        expect(log.tailSeq()).toBe(4)
        expect(log.countSince(1)).toBe(3)
    })

    it('re-admits an evicted message id as a fresh entry', () => {
        const log = new ConversationMessageLog(2)
        log.append([entry({ messageId: 'm-1', content: 'a' })])
        log.append([
            entry({ messageId: 'm-2', content: 'b' }),
            entry({ messageId: 'm-3', content: 'c' })
        ])
        log.append([entry({ messageId: 'm-1', content: 'a' })])

        expect(log.lastN(10).map((item) => item.messageId)).toEqual([
            'm-3',
            'm-1'
        ])
    })

    it('clear rejects pre-epoch timestamps and resets reads', () => {
        const log = new ConversationMessageLog(10)
        log.append([entry({ content: 'a', timestamp: 1000 })])
        log.clear(1500)

        expect(log.tailSeq()).toBeNull()
        log.append([
            entry({ content: 'old', timestamp: 999 }),
            entry({ content: 'edge', timestamp: 1500 }),
            entry({ content: 'new', timestamp: 2000 })
        ])

        expect(log.lastN(10).map((item) => item.content)).toEqual(['new'])
    })

    it('countSince is zero on an empty log', () => {
        const log = new ConversationMessageLog(10)
        expect(log.countSince(17)).toBe(0)
    })
})
