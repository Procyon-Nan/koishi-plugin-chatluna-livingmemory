import type { PGlite } from '@electric-sql/pglite'
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
    decodeVector,
    normalizeIndexKeywords,
    toPgVector
} from './vector_values'

const KEYWORD_MATCH_BOOST = 0.15
const KEYWORD_ONLY_BASE_SCORE = 0.3

interface KnnRow {
    memoryId: string
    cosineScore: number
}

const appendFilters = (query: VectorIndexKnnQuery) => {
    const conditions = ['preset_id = $1', 'status = $2']
    const parameters: unknown[] = [query.presetId, query.status]
    if (query.types !== null) {
        conditions.push(`type = ANY($${parameters.length + 1}::text[])`)
        parameters.push(query.types)
    }
    if (query.isConsolidated !== null) {
        conditions.push(`is_consolidated = $${parameters.length + 1}`)
        parameters.push(query.isConsolidated)
    }
    return { conditions, parameters }
}

export const queryVectorIndexKnn = async (
    database: PGlite,
    query: VectorIndexKnnQuery
): Promise<VectorIndexKnnHit[]> => {
    if (query.types?.length === 0 || query.limit <= 0) {
        return []
    }
    const { conditions, parameters } = appendFilters(query)
    parameters.push(toPgVector(query.vector), query.limit)
    const vectorParameter = parameters.length - 1
    const limitParameter = parameters.length
    const rows = (
        await database.query<KnnRow>(
            `SELECT
                memory_id AS "memoryId",
                1 - (embedding <=> $${vectorParameter}::vector) AS "cosineScore"
             FROM lm_index_memory
             WHERE ${conditions.join(' AND ')}
             ORDER BY embedding <=> $${vectorParameter}::vector, memory_id ASC
             LIMIT $${limitParameter}`,
            parameters
        )
    ).rows
    return rows.map((row) => ({
        memoryId: row.memoryId,
        cosineScore: Number(row.cosineScore)
    }))
}

export const queryVectorIndexHybrid = async (
    database: PGlite,
    query: VectorIndexHybridQuery
): Promise<VectorIndexHybridHit[]> => {
    if (query.types?.length === 0 || query.limit <= 0) {
        return []
    }
    const semanticHits = await queryVectorIndexKnn(database, query)
    const scores = new Map(
        semanticHits.map((hit) => [hit.memoryId, hit.cosineScore])
    )
    const keywords = normalizeIndexKeywords(query.keywords)
    if (keywords.length > 0) {
        const { conditions, parameters } = appendFilters(query)
        parameters.push(keywords, toPgVector(query.vector))
        const keywordParameter = parameters.length - 1
        const vectorParameter = parameters.length
        const keywordRows = (
            await database.query<{
                memoryId: string
                cosineScore: number
                matchCount: string
            }>(
                `SELECT
                    m.memory_id AS "memoryId",
                    1 - (m.embedding <=> $${vectorParameter}::vector) AS "cosineScore",
                    COUNT(*)::text AS "matchCount"
                 FROM lm_index_keywords AS k
                 JOIN lm_index_memory AS m ON m.memory_id = k.memory_id
                 WHERE ${conditions.map((condition) => `m.${condition}`).join(' AND ')}
                   AND k.keyword = ANY($${keywordParameter}::text[])
                 GROUP BY m.memory_id, m.embedding`,
                parameters
            )
        ).rows
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
                        boostedScore:
                            cosineScore +
                            KEYWORD_MATCH_BOOST * keywordMatchCount
                    }
                }
                if (keywordMatchCount > 0) {
                    return {
                        memoryId,
                        cosineScore: 0,
                        keywordMatchCount,
                        boostedScore:
                            KEYWORD_ONLY_BASE_SCORE * keywordMatchCount
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

    return semanticHits
        .filter(
            (hit) =>
                query.minSimilarity === 0 ||
                hit.cosineScore >= query.minSimilarity
        )
        .map((hit) => ({
            ...hit,
            keywordMatchCount: 0,
            boostedScore: hit.cosineScore
        }))
}

export const readVectorIndexVectors = async (
    database: PGlite,
    presetId: string,
    memoryIds: string[]
): Promise<VectorIndexReadVectorsResult> => {
    if (memoryIds.length === 0) {
        return { vectors: [], missingMemoryIds: [] }
    }
    const rows = (
        await database.query<{ memoryId: string; embedding: string }>(
            `SELECT memory_id AS "memoryId", embedding::text AS embedding
             FROM lm_index_memory
             WHERE preset_id = $1
               AND memory_id = ANY($2::text[])`,
            [presetId, memoryIds]
        )
    ).rows
    const vectorsByMemoryId = new Map(
        rows.map((row) => [row.memoryId, decodeVector(row.embedding)])
    )
    const vectors: VectorIndexReadVectorsResult['vectors'] = []
    const missingMemoryIds: string[] = []
    for (const memoryId of memoryIds) {
        const vector = vectorsByMemoryId.get(memoryId)
        if (vector === undefined) {
            missingMemoryIds.push(memoryId)
        } else {
            vectors.push({ memoryId, vector: new Float32Array(vector) })
        }
    }
    return { vectors, missingMemoryIds }
}

export const readVectorIndexInventoryPage = async (
    database: PGlite,
    presetId: string | null,
    afterMemoryId: string | null,
    limit: number
): Promise<VectorIndexInventoryPage> => {
    const conditions: string[] = []
    const parameters: unknown[] = []
    if (presetId !== null) {
        conditions.push(`preset_id = $${parameters.length + 1}`)
        parameters.push(presetId)
    }
    if (afterMemoryId !== null) {
        conditions.push(`memory_id > $${parameters.length + 1}`)
        parameters.push(afterMemoryId)
    }
    parameters.push(limit + 1)
    const rows = (
        await database.query<VectorIndexInventoryItem>(
            `SELECT
                memory_id AS "memoryId",
                preset_id AS "presetId",
                status,
                type,
                is_consolidated AS "isConsolidated",
                content_hash AS "contentHash",
                keywords_hash AS "keywordsHash",
                updated_at AS "updatedAt"
             FROM lm_index_memory
             ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
             ORDER BY memory_id ASC
             LIMIT $${parameters.length}`,
            parameters
        )
    ).rows
    const items = rows.slice(0, limit).map((row) => ({
        ...row,
        isConsolidated: Boolean(row.isConsolidated),
        updatedAt: Number(row.updatedAt)
    }))
    return {
        items,
        nextCursor:
            rows.length > limit ? (items.at(-1)?.memoryId ?? null) : null
    }
}
