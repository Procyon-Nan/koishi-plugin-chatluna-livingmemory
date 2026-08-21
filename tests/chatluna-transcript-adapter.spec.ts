import assert from 'node:assert/strict'
import { HumanMessage } from '@langchain/core/messages'
import type { MemoryScope } from '../src/contracts/memory'
import { createUserProfileSpeakerKey } from '../src/service/memory/speaker_identity'
import { toChatLunaTranscriptMessageResult } from '../src/service/transcript/chatluna_transcript_adapter'

const createScope = (platform?: string): MemoryScope => ({
    conversationId: 'conversation-1',
    presetId: 'preset-1',
    userId: 'user-1',
    speakerId: 'user-1',
    speakerName: '当前昵称',
    platform
})

it('derives ChatLuna profile identity from platform and message user id', () => {
    const result = toChatLunaTranscriptMessageResult(
        createScope('onebot'),
        new HumanMessage({
            id: 'user-2',
            name: '群成员',
            content: '消息正文'
        }),
        { fallbackCreatedAt: new Date('2026-08-21T00:00:00.000Z') }
    )

    assert.equal(result.reason, null)
    assert.equal(
        result.message?.speakerKey,
        createUserProfileSpeakerKey('onebot', 'user-2')
    )
})

it('does not attribute legacy history without a user id to the current scope user', () => {
    const result = toChatLunaTranscriptMessageResult(
        createScope('onebot'),
        new HumanMessage({
            name: '历史昵称',
            content: '消息正文'
        }),
        { fallbackCreatedAt: new Date('2026-08-21T00:00:00.000Z') }
    )

    assert.equal(result.reason, null)
    assert.equal(result.message?.speakerKey, undefined)
})
