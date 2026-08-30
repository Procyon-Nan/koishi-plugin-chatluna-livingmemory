import assert from 'node:assert/strict'
import { computed } from '@vue/reactivity'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { Context } from 'koishi'
import type {
    MemoryEntryRecord,
    MemoryMutationInput
} from '../src/contracts/memory'
import {
    DEFAULT_MEMORY_IMPORTANCE,
    MAX_MEMORY_KEYWORDS,
    normalizeMemoryImportance,
    normalizeMemoryKeywords,
    normalizeMemoryStatus,
    normalizeMemoryText,
    normalizeOptionalMemoryText
} from '../src/service/memory/entry_fields'
import { LivingMemoryRepository } from '../src/service/persistence/repository'
import { LivingMemoryExtractor } from '../src/service/workflows/extraction/extractor'
import {
    dreamActiveResultSchema,
    extractionResultToolName
} from '../src/service/prompts/schema'
import {
    DreamExecutor,
    type DreamExecutorRepository
} from '../src/service/workflows/dream/executor'
import {
    createToolCallingModel,
    createToolCallMessage
} from './tool-calling-test-utils'
import { createTestContext } from './persistence-test-utils'

const keywordInput = () => [
    '  alpha  ',
    'alpha',
    '',
    null,
    ...Array.from(
        { length: MAX_MEMORY_KEYWORDS },
        (_, index) => `keyword-${index}`
    )
]

it('normalizes memory text fields consistently', () => {
    assert.equal(normalizeMemoryText('  memory content  '), 'memory content')
    assert.equal(normalizeMemoryText(null), '')
    assert.equal(normalizeOptionalMemoryText('  summary  '), 'summary')
    assert.equal(normalizeOptionalMemoryText('   '), null)
})

it('normalizes and limits memory keywords consistently', () => {
    const keywords = normalizeMemoryKeywords(keywordInput())

    assert.equal(keywords.length, MAX_MEMORY_KEYWORDS)
    assert.deepEqual(keywords.slice(0, 3), ['alpha', 'keyword-0', 'keyword-1'])
    assert.equal(keywords.at(-1), `keyword-${MAX_MEMORY_KEYWORDS - 2}`)
})

it('normalizes importance and status consistently', () => {
    assert.equal(normalizeMemoryImportance(' 0.75 '), 0.75)
    assert.equal(normalizeMemoryImportance(-1), 0)
    assert.equal(normalizeMemoryImportance(2), 1)
    assert.equal(normalizeMemoryImportance('invalid'), null)
    assert.equal(
        normalizeMemoryImportance(undefined) ?? DEFAULT_MEMORY_IMPORTANCE,
        0.5
    )
    assert.equal(normalizeMemoryStatus('archived'), 'archived')
    assert.equal(normalizeMemoryStatus('invalid'), 'active')
})

it('applies shared field rules to extracted memories', async () => {
    const extractionKeywords = ['  alpha  ', 'alpha', 'keyword-0']
    const model = createToolCallingModel([
        createToolCallMessage(extractionResultToolName, {
            memories: [
                {
                    type: 'fact',
                    content: '  extracted content  ',
                    summary: '  extracted summary  ',
                    sentiment: '  neutral  ',
                    keywords: extractionKeywords,
                    importance: 1,
                    speakerLabels: ['张三']
                }
            ]
        })
    ])
    const chatluna = {
        createChatModel: async () => computed(() => model.model)
    } as unknown as Pick<Context['chatluna'], 'createChatModel'>
    const ctx = { chatluna } as unknown as Context
    const extractor = new LivingMemoryExtractor(ctx, 'test-model')

    const trace = await extractor.extractWithTrace('input', {
        conversationId: 'conversation-1',
        presetId: 'preset-1',
        presetPrompt: '你是测试助手。',
        speakers: [{ speakerLabel: '张三', speakerKey: 'speaker-key' }]
    })

    assert.equal(trace.parseError, null)
    assert.deepEqual(trace.extracted, [
        {
            type: 'fact',
            content: 'extracted content',
            summary: 'extracted summary',
            sentiment: 'neutral',
            keywords: normalizeMemoryKeywords(extractionKeywords),
            importance: 1,
            speakerKeys: ['speaker-key']
        }
    ])
})

it('applies shared field rules to Dream mutations', async () => {
    let capturedPatch: Partial<MemoryMutationInput> | undefined
    const now = new Date()
    const entry = {
        id: 'memory-1',
        presetId: 'preset-1',
        speakerKeys: [],
        type: 'fact' as const,
        status: 'active' as const,
        content: 'old content',
        keywords: ['old'],
        summary: 'old summary',
        sentiment: 'old sentiment',
        importance: 0.5,
        sourceConversationId: 'conversation-1',
        sourceOrigins: [],
        isConsolidated: false,
        createdAt: now,
        updatedAt: now
    } satisfies MemoryEntryRecord
    const repository: DreamExecutorRepository = {
        updateMemoryForDream: async (
            _presetId,
            _id,
            patch,
            _isConsolidated
        ) => {
            capturedPatch = patch
            return { record: entry, contentChanged: false }
        },
        setMemoryConsolidation: async () => [entry],
        applyDreamMerge: async () => ({
            target: entry,
            archivedSources: [],
            deletedSourceIds: [],
            targetContentChanged: false
        })
    }
    const executor = new DreamExecutor(repository)

    const dreamKeywords = ['  alpha  ', 'alpha', 'keyword-0']
    const operations = dreamActiveResultSchema.parse({
        operations: [
            {
                action: 'update',
                memoryId: entry.id,
                memory: {
                    type: 'fact',
                    content: '  dream content  ',
                    summary: '  dream summary  ',
                    sentiment: '  concerned  ',
                    keywords: dreamKeywords,
                    speakerLabels: [],
                    importance: 0
                },
                reason: 'test update'
            }
        ]
    }).operations
    const stats = await executor.executeOperations(
        entry.presetId,
        'active',
        { id: 'cluster-1', reason: 'test', entries: [entry] },
        operations,
        new Set(),
        'manual',
        []
    )

    assert.equal(stats.updated, 1)
    assert.deepEqual(capturedPatch, {
        type: 'fact',
        content: 'dream content',
        summary: 'dream summary',
        sentiment: 'concerned',
        keywords: normalizeMemoryKeywords(dreamKeywords),
        speakerKeys: [],
        importance: 0,
        status: 'active'
    })
})

it('applies shared field rules to manual persistence writes', async () => {
    const ctx = createTestContext()
    ctx.plugin(SQLiteDriver, { path: ':memory:' })
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    await ctx.start()

    try {
        const memory = await repository.createMemory(
            { conversationId: 'conversation-1', presetId: 'preset-1' },
            {
                type: 'fact',
                content: '  manual content  ',
                summary: '  manual summary  ',
                sentiment: '   ',
                keywords: keywordInput().filter(
                    (keyword): keyword is string => typeof keyword === 'string'
                ),
                importance: 2
            }
        )

        assert.equal(memory.content, 'manual content')
        assert.equal(memory.summary, 'manual summary')
        assert.equal(memory.sentiment, null)
        assert.deepEqual(
            memory.keywords,
            normalizeMemoryKeywords(keywordInput())
        )
        assert.equal(memory.importance, 1)
    } finally {
        await ctx.stop()
    }
})
