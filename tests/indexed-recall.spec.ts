import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import type {
    MemoryHybridSearchInput,
    MemorySemanticSearchInput,
    MemoryVectorSearch
} from '../src/contracts/vector_index'
import { LivingMemoryEmbeddingSearchEngine } from '../src/service/workflows/recall/embedding_search_engine'
import { LivingMemoryRetriever } from '../src/service/workflows/recall/retriever'

const createEntry = (id: string): MemoryEntryRecord => ({
    id,
    presetId: 'preset-a',
    type: 'fact',
    status: 'active',
    content: `content-${id}`,
    keywords: [id],
    summary: `summary-${id}`,
    sentiment: 'neutral',
    importance: 0.5,
    sourceConversationId: null,
    sourceOrigins: [],
    embedding: null,
    embeddingModelId: null,
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
        {
            memorySearchToolMaxResults: 30,
            memorySearchMinSimilarity: 0.4
        },
        createRepository([createEntry('memory-a'), createEntry('memory-b')]),
        vectorSearch
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
        searchTexts: ['first query', 'second query'],
        keywords: ['memory-b'],
        status: 'active',
        memoryTypes: ['fact'],
        maxCandidates: 30,
        minSimilarity: 0.4
    })
    assert.equal(results[0].boostedScore, 1.05)
})

it('fails when an index hit no longer exists in the memory repository', async () => {
    const vectorSearch = createVectorSearch({
        searchHybrid: async () => [
            {
                memoryId: 'missing-memory',
                cosineScore: 1,
                keywordMatchCount: 0,
                boostedScore: 1
            }
        ]
    })
    const engine = new LivingMemoryEmbeddingSearchEngine(
        {
            memorySearchToolMaxResults: 30,
            memorySearchMinSimilarity: 0
        },
        createRepository([]),
        vectorSearch
    )

    await assert.rejects(
        engine.searchMemories('preset-a', {
            searchTexts: ['query'],
            memoryTypes: ['all']
        }),
        /vector index result is missing/u
    )
})

it('retrieves indexed candidates and reranks only the bounded result set', async () => {
    let semanticQuery: MemorySemanticSearchInput | null = null
    const vectorSearch = createVectorSearch({
        searchSemantic: async (input: MemorySemanticSearchInput) => {
            semanticQuery = input
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
        { debug: false, rerankModel: 'test/reranker' },
        createRepository([createEntry('memory-a'), createEntry('memory-b')]),
        vectorSearch
    )

    const results = await retriever.retrieve('preset-a', 'query', 2)

    assert.equal(semanticQuery?.maxCandidates, 6)
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
        { debug: false, rerankModel: '' },
        createRepository([]),
        vectorSearch
    )

    await assert.rejects(
        retriever.retrieve('preset-a', 'query', 5),
        /vector index unavailable/u
    )
})
