import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import type {
    VectorIndexHybridHit,
    VectorIndexHybridQuery,
    VectorIndexKnnHit
} from '../src/service/vector_index/worker_protocol'
import {
    queryVectorIndexHybrid,
    queryVectorIndexKnn
} from '../src/service/vector_index/worker/queries'

interface QueryCall {
    text: string
    parameters: unknown[] | undefined
}

const createQuery = (
    options: Partial<VectorIndexHybridQuery> = {}
): VectorIndexHybridQuery => ({
    presetId: 'preset-a',
    status: 'active',
    types: null,
    isConsolidated: null,
    limit: 2,
    vector: new Float32Array([1, 0, 0]),
    keywords: ['alpha', 'beta'],
    minSimilarity: 0.5,
    ...options
})

const createDatabase = (
    semanticHits: VectorIndexKnnHit[],
    keywordRows: Array<{
        memoryId: string
        cosineScore: number | null
        matchCount: string
    }>
) => {
    const calls: QueryCall[] = []
    const database = {
        query: async (text: string, parameters?: unknown[]) => {
            calls.push({ text, parameters })
            return {
                rows: text.includes('FROM lm_index_keywords')
                    ? keywordRows
                    : semanticHits
            }
        }
    } as unknown as PGlite
    return { database, calls }
}

const legacyHybridResult = async (
    database: PGlite,
    query: VectorIndexHybridQuery,
    keywordRows: Array<{
        memoryId: string
        cosineScore: number | null
        matchCount: string
    }>
): Promise<VectorIndexHybridHit[]> => {
    const semanticHits = await queryVectorIndexKnn(database, query)
    const scores = new Map(
        semanticHits.map((hit) => [hit.memoryId, hit.cosineScore])
    )
    for (const row of keywordRows) {
        scores.set(row.memoryId, Number(row.cosineScore))
    }
    const counts = new Map(
        keywordRows.map((row) => [row.memoryId, Number(row.matchCount)])
    )
    return [...scores]
        .map(([memoryId, cosineScore]) => {
            const keywordMatchCount = counts.get(memoryId) ?? 0
            if (cosineScore >= query.minSimilarity) {
                return {
                    memoryId,
                    cosineScore,
                    keywordMatchCount,
                    boostedScore: cosineScore + 0.15 * keywordMatchCount
                }
            }
            if (keywordMatchCount > 0) {
                return {
                    memoryId,
                    cosineScore: 0,
                    keywordMatchCount,
                    boostedScore: 0.3 * keywordMatchCount
                }
            }
            return null
        })
        .filter((hit): hit is VectorIndexHybridHit => hit !== null)
        .sort(
            (left, right) =>
                right.boostedScore - left.boostedScore ||
                left.memoryId.localeCompare(right.memoryId)
        )
        .slice(0, query.limit)
}

it('reuses semantic scores for keyword candidates in the top-k intersection', async () => {
    const semanticHits = [
        { memoryId: 'semantic-alpha', cosineScore: 0.9 },
        { memoryId: 'semantic-only', cosineScore: 0.8 }
    ]
    const keywordRows = [
        {
            memoryId: 'semantic-alpha',
            cosineScore: null,
            matchCount: '2'
        },
        { memoryId: 'keyword-high', cosineScore: 0.7, matchCount: '1' },
        { memoryId: 'keyword-low', cosineScore: 0.2, matchCount: '1' }
    ]
    const { database, calls } = createDatabase(semanticHits, keywordRows)

    const result = await queryVectorIndexHybrid(database, createQuery())

    assert.deepEqual(result, [
        {
            memoryId: 'semantic-alpha',
            cosineScore: 0.9,
            keywordMatchCount: 2,
            boostedScore: 1.2
        },
        {
            memoryId: 'keyword-high',
            cosineScore: 0.7,
            keywordMatchCount: 1,
            boostedScore: 0.85
        }
    ])
    assert.equal(calls.length, 2)
    assert.match(
        calls[1].text,
        /WHEN m\.memory_id = ANY\(\$\d+::text\[\]\)\s+THEN NULL/u
    )
    assert.deepEqual(calls[1].parameters?.at(-1), [
        'semantic-alpha',
        'semantic-only'
    ])
})

it('preserves legacy hybrid scoring, filtering, and tie ordering', async () => {
    const semanticHits = [
        { memoryId: 'semantic-keyword', cosineScore: 0.4 },
        { memoryId: 'semantic-only', cosineScore: 0.6 }
    ]
    const optimizedKeywordRows = [
        {
            memoryId: 'semantic-keyword',
            cosineScore: null,
            matchCount: '1'
        },
        { memoryId: 'keyword-b', cosineScore: 0.1, matchCount: '1' },
        { memoryId: 'keyword-a', cosineScore: 0.1, matchCount: '1' }
    ]
    const legacyKeywordRows = optimizedKeywordRows.map((row) => ({
        ...row,
        cosineScore: row.memoryId === 'semantic-keyword' ? 0.4 : row.cosineScore
    }))
    const query = createQuery({ minSimilarity: 0, limit: 4 })
    const optimizedDatabase = createDatabase(
        semanticHits,
        optimizedKeywordRows
    ).database
    const legacyDatabase = createDatabase(semanticHits, []).database

    const optimized = await queryVectorIndexHybrid(optimizedDatabase, query)
    const legacy = await legacyHybridResult(
        legacyDatabase,
        query,
        legacyKeywordRows
    )

    assert.deepEqual(optimized, legacy)
    assert.deepEqual(
        optimized.map((hit) => hit.memoryId),
        ['semantic-only', 'semantic-keyword', 'keyword-a', 'keyword-b']
    )
})

it('keeps the semantic-only path unchanged for empty normalized keywords', async () => {
    const semanticHits = [
        { memoryId: 'above-threshold', cosineScore: 0.8 },
        { memoryId: 'below-threshold', cosineScore: 0.4 }
    ]
    const { database, calls } = createDatabase(semanticHits, [])

    const result = await queryVectorIndexHybrid(
        database,
        createQuery({ keywords: ['  ', ''], minSimilarity: 0.5 })
    )

    assert.deepEqual(result, [
        {
            memoryId: 'above-threshold',
            cosineScore: 0.8,
            keywordMatchCount: 0,
            boostedScore: 0.8
        }
    ])
    assert.equal(calls.length, 1)
})
