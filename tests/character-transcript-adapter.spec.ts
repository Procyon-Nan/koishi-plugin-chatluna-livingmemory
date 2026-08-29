import assert from 'node:assert/strict'
import type { Session } from 'koishi'
import type { MemoryScope } from '../src/contracts/memory'
import {
    type CharacterTranscriptSourceMessage,
    takeRecentCharacterRounds,
    toCharacterCompletedRound
} from '../src/service/transcript/character_transcript_adapter'
import { createUserProfileSpeakerKey } from '../src/service/memory/speaker_identity'

const scope: MemoryScope = {
    conversationId: 'group:1',
    presetId: '角色（Character）',
    presetLabel: '角色',
    userId: 'user-1',
    speakerId: 'user-1',
    speakerName: '用户甲',
    platform: 'onebot'
}

const session = {
    platform: 'onebot',
    userId: 'user-1',
    selfId: 'bot-1',
    username: '用户甲',
    event: {
        user: {
            nick: '用户甲'
        }
    },
    bot: {
        selfId: 'bot-1',
        user: {
            name: '角色机器人'
        },
        getUser: async (userId: string) => ({
            id: userId,
            name: `用户-${userId}`
        })
    }
} as unknown as Session

const message = (
    id: string,
    content: string,
    timestamp: number
): CharacterTranscriptSourceMessage => ({
    id,
    name: id === 'bot-1' ? '角色机器人' : `用户-${id}`,
    content,
    timestamp,
    messageId: `${id}-${timestamp}`
})

it('builds one completed Character round from the focus message and response block', async () => {
    const focus = message('user-1', '本轮问题', 2)
    const messages = [
        message('user-2', '更早的问题', 0),
        message('bot-1', '更早的回复', 1),
        focus,
        message('bot-1', '本轮回复第一段', 3),
        message('bot-1', '本轮回复第二段', 4)
    ]

    const result = await toCharacterCompletedRound(
        scope,
        session,
        messages,
        focus
    )

    assert.equal(result.reason, null)
    assert.deepEqual(
        result.round?.messages.map((item) => [item.role, item.contentLines[0]]),
        [
            ['user', '本轮问题'],
            ['assistant', '本轮回复第一段'],
            ['assistant', '本轮回复第二段']
        ]
    )
    assert.equal(
        result.round?.messages[0].speakerKey,
        createUserProfileSpeakerKey('onebot', 'user-1')
    )
})

it('excludes user messages received during the Character response from the completed round', async () => {
    const focus = message('user-1', '开始问题', 1)
    const messages = [
        focus,
        message('user-2', '响应期间的补充', 2),
        message('bot-1', '综合回复第一段', 3),
        message('user-2', '响应期间的继续补充', 4),
        message('bot-1', '综合回复第二段', 5)
    ]

    const result = await toCharacterCompletedRound(
        scope,
        session,
        messages,
        focus
    )

    assert.equal(result.reason, null)
    assert.deepEqual(
        result.round?.messages.map((item) => [item.role, item.contentLines[0]]),
        [
            ['user', '开始问题'],
            ['assistant', '综合回复第一段'],
            ['assistant', '综合回复第二段']
        ]
    )
})

it('uses the trailing assistant block when the bounded history no longer contains the focus message', async () => {
    const focus = message('user-1', '已移出窗口的问题', 1)
    const messages = [
        message('user-2', '窗口内的其他消息', 2),
        message('bot-1', '本轮回复第一段', 3),
        message('bot-1', '本轮回复第二段', 4)
    ]

    const result = await toCharacterCompletedRound(
        scope,
        session,
        messages,
        focus
    )

    assert.equal(result.reason, null)
    assert.deepEqual(
        result.round?.messages.map((item) => item.contentLines[0]),
        ['已移出窗口的问题', '本轮回复第一段', '本轮回复第二段']
    )
})

it('rejects an after-chat payload that has no assistant response after the focus message', async () => {
    const focus = message('user-1', '尚未回复的问题', 2)
    const messages = [message('bot-1', '更早的回复', 1), focus]

    const result = await toCharacterCompletedRound(
        scope,
        session,
        messages,
        focus
    )

    assert.equal(result.round, null)
    assert.equal(result.reason, 'assistant-response-missing')
})

it('rejects bot-triggered Character continuations as user conversation rounds', async () => {
    const focus = message('bot-1', '上一条机器人回复', 1)

    const result = await toCharacterCompletedRound(
        scope,
        session,
        [focus, message('bot-1', '自动续答', 2)],
        focus
    )

    assert.equal(result.round, null)
    assert.equal(result.reason, 'focus-is-assistant')
})

it('treats sender ids as authoritative when a user shares the bot display name', async () => {
    const focus = {
        ...message('user-1', '同名用户的问题', 1),
        name: '角色机器人'
    }
    const result = await toCharacterCompletedRound(
        scope,
        session,
        [focus, message('bot-1', '正常回复', 2)],
        focus
    )

    assert.equal(result.reason, null)
    assert.deepEqual(
        result.round?.messages.map((item) => item.role),
        ['user', 'assistant']
    )
})

it('slices recent character rounds by completed pairs', () => {
    const history = [
        message('user-1', '一轮', 0),
        message('bot-1', '回复一', 1),
        message('user-1', '二轮', 2),
        message('bot-1', '回复二', 3),
        message('user-1', '未回复', 4)
    ]
    assert.deepEqual(
        takeRecentCharacterRounds(session, history, 1).map(
            (item) => item.content
        ),
        ['二轮', '回复二', '未回复']
    )
    assert.deepEqual(
        takeRecentCharacterRounds(session, history, 2).map(
            (item) => item.content
        ),
        ['一轮', '回复一', '二轮', '回复二', '未回复']
    )
    assert.deepEqual(
        takeRecentCharacterRounds(session, [message('user-1', '独苗', 0)], 2),
        []
    )
})
