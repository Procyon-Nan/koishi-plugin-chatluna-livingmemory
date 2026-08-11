import type { PGlite } from '@electric-sql/pglite'
import type { MemoryVectorIndexPresetStatus } from '../../../contracts/vector_index'
import type {
    VectorIndexMutation,
    VectorIndexPreserveUpsert,
    VectorIndexReplaceUpsert
} from '../worker_protocol'
import { normalizeIndexKeywords, toPgVector } from './vector_values'

interface CountRow {
    count: string
}

const readCount = async (
    database: PGlite,
    sql: string,
    parameters: unknown[] = []
) => {
    const row = (await database.query<CountRow>(sql, parameters)).rows[0]
    return Number(row?.count ?? 0)
}

export const countVectorIndexMemories = (database: PGlite) =>
    readCount(database, 'SELECT COUNT(*)::text AS count FROM lm_index_memory')

export const applyVectorIndexMutation = async (
    database: PGlite,
    mutation: VectorIndexMutation
) => {
    const upsertIds = new Set<string>()
    const replacements: VectorIndexReplaceUpsert[] = []
    const preserves: VectorIndexPreserveUpsert[] = []
    for (const upsert of mutation.upserts) {
        const document = upsert.document
        if (document.presetId !== mutation.presetId) {
            throw new Error(
                `vector index mutation preset mismatch: ` +
                    `batch=${mutation.presetId}, memory=${document.memoryId}`
            )
        }
        if (upsertIds.has(document.memoryId)) {
            throw new Error(
                `vector index mutation contains duplicate upsert: ` +
                    `memory=${document.memoryId}`
            )
        }
        upsertIds.add(document.memoryId)
        if (upsert.vectorAction === 'replace') {
            replacements.push(upsert)
        } else {
            preserves.push(upsert)
        }
    }

    await database.transaction(async (transaction) => {
        if (mutation.deletes.length > 0) {
            await transaction.query(
                `DELETE FROM lm_index_memory
                 WHERE preset_id = $1
                   AND memory_id = ANY($2::text[])`,
                [mutation.presetId, mutation.deletes]
            )
        }

        if (replacements.length > 0) {
            const rows = replacements.map(({ document, vector }) => ({
                memory_id: document.memoryId,
                preset_id: document.presetId,
                status: document.status,
                type: document.type,
                is_consolidated: document.isConsolidated,
                content_hash: document.contentHash,
                keywords_hash: document.keywordsHash,
                updated_at: document.updatedAt,
                embedding: toPgVector(vector)
            }))
            await transaction.query(
                `INSERT INTO lm_index_memory (
                    memory_id,
                    preset_id,
                    status,
                    type,
                    is_consolidated,
                    content_hash,
                    keywords_hash,
                    updated_at,
                    embedding
                )
                SELECT
                    memory_id,
                    preset_id,
                    status,
                    type,
                    is_consolidated,
                    content_hash,
                    keywords_hash,
                    updated_at,
                    embedding::vector
                FROM jsonb_to_recordset($1::jsonb) AS input(
                    memory_id text,
                    preset_id text,
                    status text,
                    type text,
                    is_consolidated boolean,
                    content_hash text,
                    keywords_hash text,
                    updated_at bigint,
                    embedding text
                )
                    ON CONFLICT (memory_id) DO UPDATE SET
                        preset_id = excluded.preset_id,
                        status = excluded.status,
                        type = excluded.type,
                        is_consolidated = excluded.is_consolidated,
                        content_hash = excluded.content_hash,
                        keywords_hash = excluded.keywords_hash,
                        updated_at = excluded.updated_at,
                        embedding = excluded.embedding`,
                [JSON.stringify(rows)]
            )
        }

        if (preserves.length > 0) {
            const rows = preserves.map(({ document }) => ({
                memory_id: document.memoryId,
                preset_id: document.presetId,
                status: document.status,
                type: document.type,
                is_consolidated: document.isConsolidated,
                content_hash: document.contentHash,
                keywords_hash: document.keywordsHash,
                updated_at: document.updatedAt
            }))
            const result = await transaction.query<{ memoryId: string }>(
                `UPDATE lm_index_memory AS memory
                 SET preset_id = input.preset_id,
                     status = input.status,
                     type = input.type,
                     is_consolidated = input.is_consolidated,
                     content_hash = input.content_hash,
                     keywords_hash = input.keywords_hash,
                     updated_at = input.updated_at
                 FROM jsonb_to_recordset($1::jsonb) AS input(
                    memory_id text,
                    preset_id text,
                    status text,
                    type text,
                    is_consolidated boolean,
                    content_hash text,
                    keywords_hash text,
                    updated_at bigint
                 )
                 WHERE memory.memory_id = input.memory_id
                 RETURNING memory.memory_id AS "memoryId"`,
                [JSON.stringify(rows)]
            )
            const updatedIds = new Set(result.rows.map((row) => row.memoryId))
            const missing = preserves.find(
                ({ document }) => !updatedIds.has(document.memoryId)
            )
            if (missing !== undefined) {
                throw new Error(
                    `cannot preserve missing vector: ` +
                        `memory=${missing.document.memoryId}`
                )
            }
        }

        if (mutation.upserts.length > 0) {
            await transaction.query(
                `DELETE FROM lm_index_keywords
                 WHERE memory_id = ANY($1::text[])`,
                [[...upsertIds]]
            )

            const keywordRows = mutation.upserts.flatMap(({ document }) =>
                normalizeIndexKeywords(document.keywords).map((keyword) => ({
                    memory_id: document.memoryId,
                    keyword
                }))
            )
            if (keywordRows.length > 0) {
                await transaction.query(
                    `INSERT INTO lm_index_keywords (memory_id, keyword)
                     SELECT memory_id, keyword
                     FROM jsonb_to_recordset($1::jsonb) AS input(
                        memory_id text,
                        keyword text
                     )`,
                    [JSON.stringify(keywordRows)]
                )
            }
        }
    })

    return {
        indexedCount: await readCount(
            database,
            `SELECT COUNT(*)::text AS count
             FROM lm_index_memory
             WHERE preset_id = $1`,
            [mutation.presetId]
        )
    }
}

export const clearVectorIndexPreset = async (
    database: PGlite,
    presetId: string
) => {
    const deletedCount = await database.transaction(async (transaction) => {
        const deleted = await transaction.query<{ memoryId: string }>(
            `DELETE FROM lm_index_memory
             WHERE preset_id = $1
             RETURNING memory_id AS "memoryId"`,
            [presetId]
        )
        await transaction.query(
            'DELETE FROM lm_index_preset_state WHERE preset_id = $1',
            [presetId]
        )
        return deleted.rows.length
    })
    return { deletedCount }
}

export const markVectorIndexPresetState = async (
    database: PGlite,
    status: MemoryVectorIndexPresetStatus
): Promise<MemoryVectorIndexPresetStatus> => {
    await database.query(
        `INSERT INTO lm_index_preset_state (
            preset_id,
            state,
            expected_count,
            indexed_count,
            last_error,
            updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (preset_id) DO UPDATE SET
            state = excluded.state,
            expected_count = excluded.expected_count,
            indexed_count = excluded.indexed_count,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at`,
        [
            status.presetId,
            status.state,
            status.expectedCount,
            status.indexedCount,
            status.lastError,
            status.updatedAt
        ]
    )
    return status
}
