import assert from 'node:assert/strict'
import { buildMemoryTranscriptOrigin } from '../src/service/transcript/origin_context'

it('builds matching header and source label for direct conversations', () => {
    const origin = buildMemoryTranscriptOrigin({
        isDirect: true,
        speakerLabel: '小明',
        speakerId: 'user-1'
    })
    assert.equal(origin.header, '以下是你与小明（用户 ID：user-1）的聊天记录：')
    assert.equal(origin.sourceLabel, '来源于与小明（用户 ID：user-1）的私聊')
})

it('builds matching header and source label for guild conversations', () => {
    const origin = buildMemoryTranscriptOrigin({
        isDirect: false,
        guildName: '摸鱼群',
        guildId: '10001'
    })
    assert.equal(
        origin.header,
        '以下是你在「摸鱼群」（群聊 ID：10001）中的聊天记录：'
    )
    assert.equal(origin.sourceLabel, '来源于「摸鱼群」（群聊 ID：10001）的群聊')
})
