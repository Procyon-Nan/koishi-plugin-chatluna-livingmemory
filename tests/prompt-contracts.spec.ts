import assert from 'node:assert/strict'
import { memoryEntryTypes } from '../src/contracts/memory'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import { buildAgenticRecallPrompt } from '../src/service/prompts/agentic_recall'
import { buildDreamPrompt } from '../src/service/prompts/dream'
import { buildExtractionPrompt } from '../src/service/prompts/extraction'
import {
    MEMORY_CONTENT_REQUIREMENT,
    MEMORY_IMPORTANCE_REQUIREMENT,
    MEMORY_KEYWORDS_REQUIREMENT,
    MEMORY_SENTIMENT_REQUIREMENT,
    MEMORY_SPEAKER_REFERENCE_REQUIREMENT,
    MEMORY_SUMMARY_REQUIREMENT,
    MEMORY_TYPE_GUIDE
} from '../src/service/prompts/memory_fields'
import {
    EXTRACTION_OUTPUT_FORMAT,
    USER_PROFILE_OUTPUT_FORMAT
} from '../src/service/prompts/schema'
import { buildRecallRewritePrompt } from '../src/service/prompts/recall_query'
import {
    TRANSCRIPT_SPEAKER_RULE,
    TRANSCRIPT_TIMESTAMP_RULE
} from '../src/service/prompts/transcript_contract'
import { buildUserProfilePrompt } from '../src/service/prompts/user_profile'

const memoryEntry: MemoryEntryRecord = {
    id: 'memory-1',
    presetId: 'preset-1',
    type: 'fact',
    status: 'active',
    content: '张三告诉我他最近在准备考试。',
    keywords: ['张三', '准备考试'],
    summary: '张三正在准备考试',
    sentiment: '关心',
    importance: 0.7,
    sourceConversationId: 'conversation-1',
    sourceOrigins: [],
    embedding: null,
    embeddingModelId: null,
    createdAt: new Date('2026-07-15T12:00:00.000Z'),
    updatedAt: new Date('2026-07-15T12:30:00.000Z')
}

it('uses a valid memory type in the extraction output example', () => {
    const example = JSON.parse(EXTRACTION_OUTPUT_FORMAT) as { type: unknown }

    assert.equal(example.type, 'fact')
    assert.equal(typeof example.type, 'string')
    assert.ok((memoryEntryTypes as readonly string[]).includes(example.type))
})

it('shares persistent memory field rules between Extraction and Dream', () => {
    const extraction = buildExtractionPrompt({
        input: '[2026-07-15 20:00] 张三说：我最近在准备考试。',
        assistantLabel: '助手'
    }).systemPrompt
    const dream = buildDreamPrompt(
        'preset-1',
        {
            id: 'cluster-1',
            reason: 'shared speaker',
            entries: [memoryEntry]
        },
        'active'
    )

    for (const requirement of [
        MEMORY_TYPE_GUIDE,
        MEMORY_CONTENT_REQUIREMENT,
        MEMORY_SUMMARY_REQUIREMENT,
        MEMORY_KEYWORDS_REQUIREMENT,
        MEMORY_SENTIMENT_REQUIREMENT,
        MEMORY_IMPORTANCE_REQUIREMENT,
        MEMORY_SPEAKER_REFERENCE_REQUIREMENT
    ]) {
        assert.ok(extraction.includes(requirement))
        assert.ok(dream.includes(requirement))
    }
})

it('uses the shared memory entry and user profile output formats', () => {
    const prompt = buildUserProfilePrompt({
        group: {
            speakerLabel: '张三',
            entries: [memoryEntry]
        },
        maxProfileLength: 220
    })
    const outputExample = JSON.parse(USER_PROFILE_OUTPUT_FORMAT) as Record<
        string,
        unknown
    >

    assert.deepEqual(Object.keys(outputExample), [
        'speakerLabel',
        'content',
        'sourceMemoryIds'
    ])
    assert.match(prompt, /id=memory-1/u)
    assert.match(prompt, /createdAt=2026-07-15T12:00:00.000Z/u)
    assert.ok(prompt.includes(USER_PROFILE_OUTPUT_FORMAT))
})

it('shares transcript interpretation rules across prompt workflows', () => {
    const extraction = buildExtractionPrompt({
        input: '历史消息',
        assistantLabel: '助手'
    }).systemPrompt
    const recall = buildRecallRewritePrompt({
        presetLabel: '助手',
        currentTranscript: '当前消息',
        cleanedQuery: '当前消息',
        history: '历史消息'
    })
    const agenticRecall = buildAgenticRecallPrompt({
        presetLabel: '助手',
        currentTranscript: '当前消息',
        history: '历史消息'
    })

    for (const prompt of [extraction, recall, agenticRecall]) {
        assert.ok(prompt.includes(TRANSCRIPT_SPEAKER_RULE))
        assert.ok(prompt.includes(TRANSCRIPT_TIMESTAMP_RULE))
    }
})
