import type { PGlite } from '@electric-sql/pglite'
import type {
    DreamNeighborHit,
    DreamNeighborPageResult,
    DreamNeighborQuery
} from '../../../contracts/vector_index'
import { LivingMemoryVectorIndexError } from '../errors'
import { toPgVector } from './vector_values'

const DREAM_HNSW_INDEX = 'lm_index_memory_dream_hnsw_v1'

export const isDreamAnnReady = async (database: PGlite) => {
    const result = await database.query<{ ready: boolean }>(
        `SELECT i.indisvalid AND i.indisready
                AND i.indrelid = 'lm_index_memory'::regclass
                AND am.amname = 'hnsw'
                AND i.indnkeyatts = 1 AND i.indnatts = 1
                AND a.attname = 'embedding'
                AND opc.opcname = 'vector_cosine_ops'
                AND c.reloptions @> ARRAY['m=16', 'ef_construction=64']
                AND pg_get_expr(i.indpred, i.indrelid) = '(status = ''active''::text)'
                AS ready
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_am am ON am.oid = c.relam
         JOIN pg_opclass opc ON opc.oid = i.indclass[0]
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
         WHERE i.indexrelid = to_regclass($1)`,
        [DREAM_HNSW_INDEX]
    )
    return result.rows[0]?.ready === true
}

export const buildDreamAnnIndex = async (database: PGlite) => {
    if (await isDreamAnnReady(database)) {
        return { built: false }
    }
    await database.transaction(async (tx) => {
        await tx.exec(`
            SET LOCAL maintenance_work_mem = '64MB';
            SET LOCAL max_parallel_maintenance_workers = 0;
            DROP INDEX IF EXISTS ${DREAM_HNSW_INDEX};
            CREATE INDEX ${DREAM_HNSW_INDEX}
            ON lm_index_memory USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
            WHERE status = 'active';
            ANALYZE lm_index_memory;
        `)
    })
    return { built: true }
}

interface QueryPlan {
    'Index Name'?: string
    Plans?: QueryPlan[]
}

const usesDreamHnsw = (plan: QueryPlan): boolean =>
    plan['Index Name'] === DREAM_HNSW_INDEX ||
    (plan.Plans?.some(usesDreamHnsw) ?? false)

export const queryDreamNeighbors = async (
    database: PGlite,
    queries: DreamNeighborQuery[],
    cancellation: Int32Array<SharedArrayBuffer>
): Promise<DreamNeighborPageResult> => {
    if (queries.length === 0 || queries.length > 4) {
        throw new Error('Dream neighbor page requires 1 to 4 queries')
    }
    const startedAt = performance.now()
    const { generation } = (
        await database.query<{ generation: string }>(
            'SELECT generation FROM lm_index_manifest WHERE singleton = 1'
        )
    ).rows[0]
    if (queries.some((query) => query.generation !== generation)) {
        throw new LivingMemoryVectorIndexError(
            'not-ready',
            'unavailable',
            'Dream vector index generation changed'
        )
    }
    const result: DreamNeighborPageResult = {
        generation,
        completed: 0,
        backend: 'unavailable',
        rows: []
    }
    if (!(await isDreamAnnReady(database))) {
        return { ...result, reason: 'index-absent' }
    }
    result.backend = 'hnsw'
    for (const query of queries) {
        if (Atomics.load(cancellation, 0) !== 0) {
            throw new Error('Dream neighbor query cancelled')
        }
        const hits = await database.transaction(async (tx) => {
            await tx.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [
                String(query.efSearch)
            ])
            await tx.exec(`
                SET LOCAL hnsw.iterative_scan = 'strict_order';
                SET LOCAL hnsw.max_scan_tuples = 2000;
                SET LOCAL hnsw.scan_mem_multiplier = 1;
                SET LOCAL work_mem = '4MB';
            `)
            const sql = `SELECT memory_id AS "memoryId",
                                content_hash AS "contentHash"
                         FROM lm_index_memory
                         WHERE preset_id = $2 AND status = 'active'
                           AND memory_id <> $3
                         ORDER BY embedding <=> $1::vector, memory_id ASC
                         LIMIT $4`
            const params = [
                toPgVector(query.vector),
                query.presetId,
                query.sourceMemoryId,
                query.limit
            ]
            const explanation = await tx.query<{
                'QUERY PLAN': { Plan: QueryPlan }[]
            }>(`EXPLAIN (FORMAT JSON) ${sql}`, params)
            if (!usesDreamHnsw(explanation.rows[0]['QUERY PLAN'][0].Plan)) {
                return null
            }
            return (await tx.query<DreamNeighborHit>(sql, params)).rows
        })
        if (hits === null) {
            return { ...result, backend: 'unavailable', reason: 'plan-exact' }
        }
        result.rows.push({ sourceIndex: query.sourceIndex, hits })
        result.completed++
        if (
            result.completed < queries.length &&
            performance.now() - startedAt >= 25
        ) {
            result.reason = 'budget'
            break
        }
    }
    return result
}
