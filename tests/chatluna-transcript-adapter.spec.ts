import assert from 'node:assert/strict'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { Session } from 'koishi'
import type { MemoryScope } from '../src/contracts/memory'
import { createUserProfileSpeakerKey } from '../src/service/memory/speaker_identity'
import {
    takeRecentChatLunaRounds,
    toChatLunaTranscriptMessageResult
} from '../src/service/transcript/chatluna_transcript_adapter'

const createScope = (platform?: string): MemoryScope => ({
    conversationId: 'conversation-1',
    presetId: 'preset-1',
    userId: 'user-1',
    speakerId: 'user-1',
    speakerName: '当前昵称',
    platform
})

const createSession = () =>
    ({
        platform: 'onebot',
        guildId: 'guild-1',
        event: {
            user: {
                id: 'user-1',
                name: '当前全局昵称',
                nick: '当前群名片'
            }
        },
        bot: {
            getUser: async (userId: string) => ({
                id: userId,
                name: `全局昵称-${userId}`
            })
        }
    }) as unknown as Session

it('derives ChatLuna profile identity and global name from message user id', async () => {
    const result = await toChatLunaTranscriptMessageResult(
        createScope('onebot'),
        createSession(),
        new HumanMessage({
            id: 'user-2',
            name: '群名片',
            content: '消息正文'
        }),
        { fallbackCreatedAt: new Date('2026-08-21T00:00:00.000Z') }
    )

    assert.equal(result.reason, null)
    assert.equal(
        result.message?.speakerKey,
        createUserProfileSpeakerKey('onebot', 'user-2')
    )
    assert.equal(result.message?.speakerLabel, '全局昵称-user-2')
})

it('uses the current user global name instead of the guild nickname', async () => {
    const result = await toChatLunaTranscriptMessageResult(
        createScope('onebot'),
        createSession(),
        new HumanMessage({
            id: 'user-1',
            name: '群名片',
            content: '消息正文'
        }),
        { fallbackCreatedAt: new Date('2026-08-21T00:00:00.000Z') }
    )

    assert.equal(result.reason, null)
    assert.equal(result.message?.speakerLabel, '全局昵称-user-1')
})

it('rejects ChatLuna history without a user id', async () => {
    await assert.rejects(
        toChatLunaTranscriptMessageResult(
            createScope('onebot'),
            createSession(),
            new HumanMessage({
                name: '历史昵称',
                content: '消息正文'
            }),
            { fallbackCreatedAt: new Date('2026-08-21T00:00:00.000Z') }
        ),
        /has no id/u
    )
})

it('slices recent chat rounds by completed pairs', () => {
    const history = [
        new HumanMessage({ id: 'user-1', content: '一轮' }),
        new AIMessage({ content: '回复一' }),
        new HumanMessage({ id: 'user-1', content: '二轮' }),
        new AIMessage({ content: '回复二' }),
        new HumanMessage({ id: 'user-1', content: '未回复' })
    ]
    assert.deepEqual(
        takeRecentChatLunaRounds(history, 1).map((message) => message.content),
        ['二轮', '回复二', '未回复']
    )
    assert.deepEqual(
        takeRecentChatLunaRounds(history, 2).map((message) => message.content),
        ['一轮', '回复一', '二轮', '回复二', '未回复']
    )
    assert.deepEqual(
        takeRecentChatLunaRounds(
            [new HumanMessage({ id: 'user-1', content: '独苗' })],
            2
        ),
        []
    )
})
