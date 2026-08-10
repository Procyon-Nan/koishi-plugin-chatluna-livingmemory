import type { PGlite } from '@electric-sql/pglite'
import type { MemoryVectorIndexPresetStatus } from '../../../contracts/vector_index'
import type { VectorIndexMutation } from '../worker_protocol'
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
    await database.transaction(async (transaction) => {
        for (const memoryId of mutation.deletes) {
            await transaction.query(
                `DELETE FROM lm_index_memory
                 WHERE preset_id = $1 AND memory_id = $2`,
                [mutation.presetId, memoryId]
            )
        }

        for (const upsert of mutation.upserts) {
            const document = upsert.document
            if (document.presetId !== mutation.presetId) {
                throw new Error(
                    `vector index mutation preset mismatch: batch=${mutation.presetId}, memory=${document.memoryId}`
                )
            }

            if (upsert.vectorAction === 'replace') {
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
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
                    ON CONFLICT (memory_id) DO UPDATE SET
                        preset_id = excluded.preset_id,
                        status = excluded.status,
                        type = excluded.type,
                        is_consolidated = excluded.is_consolidated,
                        content_hash = excluded.content_hash,
                        keywords_hash = excluded.keywords_hash,
                        updated_at = excluded.updated_at,
                        embedding = excluded.embedding`,
                    [
                        document.memoryId,
                        document.presetId,
                        document.status,
                        document.type,
                        document.isConsolidated,
                        document.contentHash,
                        document.keywordsHash,
                        document.updatedAt,
                        toPgVector(upsert.vector)
                    ]
                )
            } else {
                const result = await transaction.query(
                    `UPDATE lm_index_memory
                     SET preset_id = $1,
                         status = $2,
                         type = $3,
                         is_consolidated = $4,
                         content_hash = $5,
                         keywords_hash = $6,
                         updated_at = $7
                     WHERE memory_id = $8`,
                    [
                        document.presetId,
                        document.status,
                        document.type,
                        document.isConsolidated,
                        document.contentHash,
                        document.keywordsHash,
                        document.updatedAt,
                        document.memoryId
                    ]
                )
                if (result.affectedRows !== 1) {
                    throw new Error(
                        `cannot preserve missing vector: memory=${document.memoryId}`
                    )
                }
            }

            await transaction.query(
                'DELETE FROM lm_index_keywords WHERE memory_id = $1',
                [document.memoryId]
            )
            for (const keyword of normalizeIndexKeywords(document.keywords)) {
                await transaction.query(
                    `INSERT INTO lm_index_keywords (memory_id, keyword)
                     VALUES ($1, $2)`,
                    [document.memoryId, keyword]
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
    const deletedCount = await readCount(
        database,
        `SELECT COUNT(*)::text AS count
         FROM lm_index_memory
         WHERE preset_id = $1`,
        [presetId]
    )
    await database.transaction(async (transaction) => {
        await transaction.query(
            'DELETE FROM lm_index_memory WHERE preset_id = $1',
            [presetId]
        )
        await transaction.query(
            'DELETE FROM lm_index_preset_state WHERE preset_id = $1',
            [presetId]
        )
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
