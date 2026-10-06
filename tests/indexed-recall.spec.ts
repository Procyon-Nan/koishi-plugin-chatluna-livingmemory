import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import type {
    MemoryHybridSearchHit,
    MemoryHybridSearchInput,
    MemorySemanticSearchInput,
    MemoryVectorSearch
} from '../src/contracts/vector_index'
import { LivingMemoryEmbeddingSearchEngine } from '../src/service/workflows/recall/embedding_search_engine'
import { LivingMemoryRetriever } from '../src/service/workflows/recall/retriever'
import { createCapturedLogger, logger } from './workflow-test-utils'

const createEntry = (id: string): MemoryEntryRecord => ({
    id,
    presetId: 'preset-a',
    speakerKeys: [],
    type: 'fact',
    status: 'active',
    content: `content-${id}`,
    keywords: [id],
    summary: `summary-${id}`,
    sentiment: 'neutral',
    importance: 0.5,
    sourceConversationId: null,
    sourceLabel: null,
    sourceOrigins: [],
    isConsolidated: false,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z')
})

const createRepository = (entries: MemoryEntryRecord[]) => ({
    getRecallEntriesByPresetAndIds: async (presetId: string, ids: string[]) => {
        assert.equal(presetId, 'preset-a')
        const idSet = new Set(ids)
        return entries.filter((entry) => idSet.has(entry.id)).reverse()
    }
})

const createVectorSearch = (
    overrides: Partial<MemoryVectorSearch>
): MemoryVectorSearch => ({
    searchSemantic: async () => [],
    searchHybrid: async () => [],
    ...overrides
})

const createHit = (
    memoryId: string,
    boostedScore: number
): MemoryHybridSearchHit => ({
    memoryId,
    cosineScore: boostedScore,
    keywordMatchCount: 0,
    boostedScore
})

const createRerankerContext = (
    rerank: (
        documents: string[],
        query: string
    ) => Promise<{ index: number; relevanceScore: number }[]>
) =>
    ({
        chatluna: {
            createReranker: async () => ({ value: { rerank } })
        }
    }) as unknown as Context

it('uses the vector index for hybrid search and restores hit order', async () => {
    let query: MemoryHybridSearchInput | null = null
    const vectorSearch = createVectorSearch({
        searchHybrid: async (input: MemoryHybridSearchInput) => {
            query = input
            return [
                {
                    memoryId: 'memory-b',
                    cosineScore: 0.9,
                    keywordMatchCount: 1,
                    boostedScore: 1.05
                },
                {
                    memoryId: 'memory-a',
                    cosineScore: 0.8,
                    keywordMatchCount: 0,
                    boostedScore: 0.8
                }
            ]
        }
    })
    const engine = new LivingMemoryEmbeddingSearchEngine(
        {} as Context,
        {
            memorySearchToolMaxResults: 30,
            memorySearchMinSimilarity: 0.4,
            rerankModel: '无'
        },
        createRepository([createEntry('memory-a'), createEntry('memory-b')]),
        vectorSearch,
        logger
    )

    const results = await engine.searchMemoriesDetailed('preset-a', {
        searchTexts: ['first query', 'second query'],
        searchKeywords: ['memory-b'],
        memoryTypes: ['fact']
    })

    assert.deepEqual(
        results.map((result) => result.id),
        ['memory-b', 'memory-a']
    )
    assert.deepEqual(query, {
        presetId: 'preset-a',
        conversationId: undefined,
        searchTexts: ['first query', 'second query'],
        keywords: ['memory-b'],
        memoryTypes: ['fact'],
        memoryStatus: 'active',
        maxCandidates: 30,
        minSimilarity: 0.4
    })
    assert.equal(results[0].boostedScore, 1.05)
    assert.equal(results[0].rerankScore, null)
})

it('fails when an index hit no longer exists in the memory repository', async () => {
    const vectorSearch = createVectorSearch({
        searchHybrid: async () => [createHit('missing-memory', 1)]
    })
    const engine = new LivingMemoryEmbeddingSearchEngine(
        {} as Context,
        {
            memorySearchToolMaxResults: 30,
            memorySearchMinSimilarity: 0,
            rerankModel: '无'
        },
        createRepository([]),
        vectorSearch,
        logger
    )

    await assert.rejects(
        engine.searchMemories('preset-a', {
            searchTexts: ['query'],
            memoryTypes: ['all']
        }),
        /vector index result is missing/u
    )
})

it('reranks widened candidates per search text and keeps the best score', async () => {
    const hybridQueries: MemoryHybridSearchInput[] = []
    const rerankQueries: string[] = []
    const vectorSearch = createVectorSearch({
        searchHybrid: async (input: MemoryHybridSearchInput) => {
            hybridQueries.push(input)
            return [
                createHit('memory-a', 0.9),
                createHit('memory-b', 0.8),
                createHit('memory-c', 0.7)
            ]
        }
    })
    const engine = new LivingMemoryEmbeddingSearchEngine(
        createRerankerContext(async (documents, query) => {
            rerankQueries.push(query)
            assert.deepEqual(documents, [
                'content-memory-a',
                'content-memory-b',
                'content-memory-c'
            ])
            return query === 'first query'
                ? [
                      { index: 2, relevanceScore: 0.6 },
                      { index: 0, relevanceScore: 0.2 }
                  ]
                : [
                      { index: 1, relevanceScore: 0.9 },
                      { index: 2, relevanceScore: 0.1 }
                  ]
        }),
        {
            memorySearchToolMaxResults: 2,
            memorySearchMinSimilarity: 0,
            rerankModel: 'test/reranker'
        },
        createRepository([
            createEntry('memory-a'),
            createEntry('memory-b'),
            createEntry('memory-c')
        ]),
        vectorSearch,
        logger
    )

    const results = await engine.searchMemoriesDetailed('preset-a', {
        searchTexts: ['first query', 'second query'],
        memoryTypes: ['all']
    })

    assert.equal(hybridQueries[0]?.maxCandidates, 6)
    assert.deepEqual(rerankQueries, ['first query', 'second query'])
    assert.deepEqual(
        results.map((result) => [result.id, result.rerankScore]),
        [
            ['memory-b', 0.9],
            ['memory-c', 0.6]
        ]
    )
})

it('falls back to hybrid order when the reranker fails', async () => {
    const rerankError = new Error('reranker unavailable')
    const captured = createCapturedLogger()
    const vectorSearch = createVectorSearch({
        searchHybrid: async () => [
            createHit('memory-a', 0.9),
            createHit('memory-b', 0.8)
        ]
    })
    const engine = new LivingMemoryEmbeddingSearchEngine(
        createRerankerContext(async () => {
            throw rerankError
        }),
        {
            memorySearchToolMaxResults: 1,
            memorySearchMinSimilarity: 0,
            rerankModel: 'test/reranker'
        },
        createRepository([createEntry('memory-a'), createEntry('memory-b')]),
        vectorSearch,
        captured.logger
    )

    const results = await engine.searchMemoriesDetailed('preset-a', {
        searchTexts: ['query'],
        memoryTypes: ['all']
    })

    assert.deepEqual(
        results.map((result) => [result.id, result.rerankScore]),
        [['memory-a', null]]
    )
    assert.match(
        String(captured.warnings[0]?.[0]),
        /event=search.rerank.failed/u
    )
    assert.equal(captured.warnings[0]?.[1], rerankError)
})

it('propagates vector index failures', async () => {
    const vectorSearch = createVectorSearch({
        searchHybrid: async () => {
            throw new Error('vector index unavailable')
        }
    })
    const engine = new LivingMemoryEmbeddingSearchEngine(
        {} as Context,
        {
            memorySearchToolMaxResults: 5,
            memorySearchMinSimilarity: 0,
            rerankModel: '无'
        },
        createRepository([]),
        vectorSearch,
        logger
    )

    await assert.rejects(
        engine.searchMemories('preset-a', {
            searchTexts: ['query'],
            memoryTypes: ['all']
        }),
        /vector index unavailable/u
    )
})

it('retrieves indexed candidates and reranks only the bounded result set', async () => {
    const semanticQueries: MemorySemanticSearchInput[] = []
    const vectorSearch = createVectorSearch({
        searchSemantic: async (input: MemorySemanticSearchInput) => {
            semanticQueries.push(input)
            return [
                { memoryId: 'memory-a', cosineScore: 0.9 },
                { memoryId: 'memory-b', cosineScore: 0.8 }
            ]
        }
    })
    const context = {
        logger: () => ({ info: () => {}, warn: () => {} }),
        chatluna: {
            createReranker: async () => ({
                value: {
                    rerank: async () => [{ index: 1, relevanceScore: 0.95 }]
                }
            })
        }
    } as unknown as Context
    const retriever = new LivingMemoryRetriever(
        context,
        { rerankModel: 'test/reranker' },
        createRepository([createEntry('memory-a'), createEntry('memory-b')]),
        vectorSearch,
        logger
    )

    const results = await retriever.retrieve('preset-a', 'query', 2)

    assert.equal(semanticQueries[0]?.maxCandidates, 6)
    assert.deepEqual(results, [
        { id: 'memory-b', content: 'content-memory-b', score: 0.95 }
    ])
})

it('propagates vector index failures without returning an empty recall', async () => {
    const vectorSearch = createVectorSearch({
        searchSemantic: async () => {
            throw new Error('vector index unavailable')
        }
    })
    const context = {
        logger: () => ({ info: () => {}, warn: () => {} })
    } as unknown as Context
    const retriever = new LivingMemoryRetriever(
        context,
        { rerankModel: '' },
        createRepository([]),
        vectorSearch,
        logger
    )

    await assert.rejects(
        retriever.retrieve('preset-a', 'query', 5),
        /vector index unavailable/u
    )
})

it('keeps rerank fallback warnings correlated with the recall run', async () => {
    const rerankError = new Error('reranker unavailable')
    const captured = createCapturedLogger()
    const vectorSearch = createVectorSearch({
        searchSemantic: async () => [{ memoryId: 'memory-a', cosineScore: 0.9 }]
    })
    const context = {
        chatluna: {
            createReranker: async () => ({
                value: {
                    rerank: async () => {
                        throw rerankError
                    }
                }
            })
        }
    } as unknown as Context
    const retriever = new LivingMemoryRetriever(
        context,
        { rerankModel: 'test/reranker' },
        createRepository([createEntry('memory-a')]),
        vectorSearch,
        captured.logger
    )
    const runLogger = captured.logger.with({
        workflow: 'recall',
        runId: 'run-1',
        presetId: 'preset-a',
        conversationId: 'conversation-a'
    })

    const results = await retriever.retrieve('preset-a', 'query', 1, runLogger)

    assert.deepEqual(results, [
        { id: 'memory-a', content: 'content-memory-a', score: 0.9 }
    ])
    assert.match(
        String(captured.warnings[0]?.[0]),
        /event=recall.rerank.failed workflow=recall runId=run-1 presetId=preset-a conversationId=conversation-a/u
    )
    assert.equal(captured.warnings[0]?.[1], rerankError)
})
