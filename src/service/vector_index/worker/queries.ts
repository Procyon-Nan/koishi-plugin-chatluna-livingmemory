import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
    VectorIndexHybridHit,
    VectorIndexHybridQuery,
    VectorIndexInventoryItem,
    VectorIndexInventoryPage,
    VectorIndexKnnHit,
    VectorIndexKnnQuery,
    VectorIndexReadVectorsResult
} from '../worker_protocol'
import {
    calculateCosine,
    decodeVector,
    normalizeIndexKeywords,
    toSqliteBoolean,
    toSqliteVector
} from './vector_values'

const KEYWORD_MATCH_BOOST = 0.15
const KEYWORD_ONLY_BASE_SCORE = 0.3

interface KnnRow {
    memoryId: string
    distance: number
}

interface VectorRow {
    memoryId: string
    embedding: Uint8Array
}

interface KeywordCandidateRow extends VectorRow {
    matchCount: number
}

interface InventoryRow {
    memoryId: string
    presetId: string
    status: VectorIndexInventoryItem['status']
    type: VectorIndexInventoryItem['type']
    isConsolidated: number
    contentHash: string
    keywordsHash: string
    updatedAt: number
}

const toInventoryItem = (row: InventoryRow): VectorIndexInventoryItem => ({
    memoryId: row.memoryId,
    presetId: row.presetId,
    status: row.status,
    type: row.type,
    isConsolidated: row.isConsolidated === 1,
    contentHash: row.contentHash,
    keywordsHash: row.keywordsHash,
    updatedAt: row.updatedAt
})

const compareKnnHits = (left: VectorIndexKnnHit, right: VectorIndexKnnHit) => {
    const scoreDifference = right.cosineScore - left.cosineScore
    if (scoreDifference !== 0) {
        return scoreDifference
    }
    return left.memoryId.localeCompare(right.memoryId)
}

const queryKnnForType = (
    database: DatabaseSync,
    query: VectorIndexKnnQuery,
    type: VectorIndexInventoryItem['type'] | null
) => {
    const conditions = [
        'v.embedding MATCH ?',
        'v.k = ?',
        'v.preset_id = ?',
        'v.status = ?'
    ]
    const parameters: SQLInputValue[] = [
        toSqliteVector(query.vector),
        query.limit,
        query.presetId,
        query.status
    ]
    if (type !== null) {
        conditions.push('v.type = ?')
        parameters.push(type)
    }
    if (query.isConsolidated !== null) {
        conditions.push('v.is_consolidated = ?')
        parameters.push(toSqliteBoolean(query.isConsolidated))
    }

    return database
        .prepare(
            `SELECT
                m.memory_id AS memoryId,
                v.distance
             FROM lm_index_vectors AS v
             JOIN lm_index_memory AS m ON m.rowid = v.rowid
             WHERE ${conditions.join(' AND ')}
             ORDER BY v.distance ASC, m.memory_id ASC`
        )
        .all(...parameters) as unknown as KnnRow[]
}

export const queryVectorIndexKnn = (
    database: DatabaseSync,
    query: VectorIndexKnnQuery
): VectorIndexKnnHit[] => {
    if (query.types !== null && query.types.length === 0) {
        return []
    }

    const types = query.types ?? [null]
    const bestByMemoryId = new Map<string, number>()
    for (const type of types) {
        const rows = queryKnnForType(database, query, type)
        for (const row of rows) {
            const cosineScore = 1 - row.distance
            const existing = bestByMemoryId.get(row.memoryId)
            if (existing === undefined || cosineScore > existing) {
                bestByMemoryId.set(row.memoryId, cosineScore)
            }
        }
    }

    return [...bestByMemoryId]
        .map(([memoryId, cosineScore]) => ({ memoryId, cosineScore }))
        .sort(compareKnnHits)
        .slice(0, query.limit)
}

const queryKeywordCandidates = (
    database: DatabaseSync,
    query: VectorIndexHybridQuery
) => {
    const keywords = normalizeIndexKeywords(query.keywords)
    if (keywords.length === 0) {
        return []
    }
    if (query.types !== null && query.types.length === 0) {
        return []
    }

    const keywordPlaceholders = keywords.map(() => '?').join(', ')
    const conditions = [
        'm.preset_id = ?',
        'm.status = ?',
        `k.keyword IN (${keywordPlaceholders})`
    ]
    const parameters: SQLInputValue[] = [query.presetId, query.status, ...keywords]
    if (query.types !== null) {
        const typePlaceholders = query.types.map(() => '?').join(', ')
        conditions.push(`m.type IN (${typePlaceholders})`)
        parameters.push(...query.types)
    }
    if (query.isConsolidated !== null) {
        conditions.push('m.is_consolidated = ?')
        parameters.push(toSqliteBoolean(query.isConsolidated))
    }

    return database
        .prepare(
            `SELECT
                matches.memoryId,
                v.embedding,
                matches.matchCount
             FROM (
                SELECT
                    m.rowid,
                    m.memory_id AS memoryId,
                    COUNT(*) AS matchCount
                FROM lm_index_keywords AS k
                JOIN lm_index_memory AS m ON m.rowid = k.memory_rowid
                WHERE ${conditions.join(' AND ')}
                GROUP BY m.rowid, m.memory_id
             ) AS matches
             JOIN lm_index_vectors AS v ON v.rowid = matches.rowid`
        )
        .all(...parameters) as unknown as KeywordCandidateRow[]
}

export const queryVectorIndexHybrid = (
    database: DatabaseSync,
    query: VectorIndexHybridQuery
): VectorIndexHybridHit[] => {
    const semanticHits = queryVectorIndexKnn(database, query)
    const semanticScores = new Map(
        semanticHits.map((hit) => [hit.memoryId, hit.cosineScore])
    )
    const keywordCandidates = queryKeywordCandidates(database, query)
    const keywordByMemoryId = new Map(
        keywordCandidates.map((candidate) => [candidate.memoryId, candidate])
    )
    const memoryIds = new Set([
        ...semanticScores.keys(),
        ...keywordByMemoryId.keys()
    ])
    const hits: VectorIndexHybridHit[] = []

    for (const memoryId of memoryIds) {
        const keywordCandidate = keywordByMemoryId.get(memoryId)
        let cosineScore = semanticScores.get(memoryId)
        if (cosineScore === undefined && keywordCandidate !== undefined) {
            cosineScore = calculateCosine(
                decodeVector(keywordCandidate.embedding),
                query.vector
            )
        }
        if (cosineScore === undefined) {
            continue
        }

        const keywordMatchCount = keywordCandidate?.matchCount ?? 0
        const passesSimilarityThreshold =
            query.minSimilarity === 0 || cosineScore >= query.minSimilarity
        if (passesSimilarityThreshold) {
            hits.push({
                memoryId,
                cosineScore,
                keywordMatchCount,
                boostedScore:
                    cosineScore + KEYWORD_MATCH_BOOST * keywordMatchCount
            })
            continue
        }

        if (keywordMatchCount > 0) {
            hits.push({
                memoryId,
                cosineScore: 0,
                keywordMatchCount,
                boostedScore: KEYWORD_ONLY_BASE_SCORE * keywordMatchCount
            })
        }
    }

    return hits
        .sort((left, right) => {
            const scoreDifference = right.boostedScore - left.boostedScore
            if (scoreDifference !== 0) {
                return scoreDifference
            }
            return left.memoryId.localeCompare(right.memoryId)
        })
        .slice(0, query.limit)
}

export const readVectorIndexVectors = (
    database: DatabaseSync,
    presetId: string,
    memoryIds: string[]
): VectorIndexReadVectorsResult => {
    if (memoryIds.length === 0) {
        return { vectors: [], missingMemoryIds: [] }
    }

    const placeholders = memoryIds.map(() => '?').join(', ')
    const rows = database
        .prepare(
            `SELECT
                m.memory_id AS memoryId,
                v.embedding
             FROM lm_index_memory AS m
             JOIN lm_index_vectors AS v ON v.rowid = m.rowid
             WHERE m.preset_id = ?
               AND m.memory_id IN (${placeholders})`
        )
        .all(presetId, ...memoryIds) as unknown as VectorRow[]
    const vectorsById = new Map(
        rows.map((row) => [row.memoryId, decodeVector(row.embedding)])
    )
    const vectors: VectorIndexReadVectorsResult['vectors'] = []
    const missingMemoryIds: string[] = []
    for (const memoryId of memoryIds) {
        const vector = vectorsById.get(memoryId)
        if (vector === undefined) {
            missingMemoryIds.push(memoryId)
            continue
        }
        vectors.push({ memoryId, vector })
    }

    return { vectors, missingMemoryIds }
}

export const readVectorIndexInventoryPage = (
    database: DatabaseSync,
    presetId: string | null,
    afterMemoryId: string | null,
    limit: number
): VectorIndexInventoryPage => {
    const conditions: string[] = []
    const parameters: (string | number)[] = []
    if (presetId !== null) {
        conditions.push('preset_id = ?')
        parameters.push(presetId)
    }
    if (afterMemoryId !== null) {
        conditions.push('memory_id > ?')
        parameters.push(afterMemoryId)
    }

    let whereClause = ''
    if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`
    }
    const rows = database
        .prepare(
            `SELECT
                memory_id AS memoryId,
                preset_id AS presetId,
                status,
                type,
                is_consolidated AS isConsolidated,
                content_hash AS contentHash,
                keywords_hash AS keywordsHash,
                updated_at AS updatedAt
             FROM lm_index_memory
             ${whereClause}
             ORDER BY memory_id ASC
             LIMIT ?`
        )
        .all(...parameters, limit + 1) as unknown as InventoryRow[]
    const items = rows.slice(0, limit).map(toInventoryItem)
    let nextCursor: string | null = null
    if (rows.length > limit) {
        nextCursor = items[items.length - 1].memoryId
    }
    return { items, nextCursor }
}
