import type { DatabaseSync } from 'node:sqlite'
import type { MemoryVectorIndexPresetStatus } from '../../../contracts/vector_index'
import type { VectorIndexMutation, VectorIndexUpsert } from '../worker_protocol'
import {
    normalizeIndexKeywords,
    toSqliteBoolean,
    toSqliteVector
} from './vector_values'

interface CountRow {
    count: number
}

interface MemoryRowId {
    rowid: number
}

const prepareMutationStatements = (database: DatabaseSync) => ({
    selectMemory: database.prepare(
        `SELECT rowid
         FROM lm_index_memory
         WHERE memory_id = ?`
    ),
    selectMemoryInPreset: database.prepare(
        `SELECT rowid
         FROM lm_index_memory
         WHERE preset_id = ? AND memory_id = ?`
    ),
    insertMemory: database.prepare(
        `INSERT INTO lm_index_memory (
            memory_id,
            preset_id,
            status,
            type,
            is_consolidated,
            content_hash,
            keywords_hash,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateMemory: database.prepare(
        `UPDATE lm_index_memory
         SET preset_id = ?,
             status = ?,
             type = ?,
             is_consolidated = ?,
             content_hash = ?,
             keywords_hash = ?,
             updated_at = ?
         WHERE rowid = ?`
    ),
    deleteMemory: database.prepare(
        'DELETE FROM lm_index_memory WHERE rowid = ?'
    ),
    insertVector: database.prepare(
        `INSERT INTO lm_index_vectors (
            rowid,
            embedding,
            preset_id,
            status,
            type,
            is_consolidated
        ) VALUES (?, ?, ?, ?, ?, ?)`
    ),
    updateVector: database.prepare(
        `UPDATE lm_index_vectors
         SET status = ?,
             type = ?,
             is_consolidated = ?
         WHERE rowid = ?`
    ),
    deleteVector: database.prepare(
        'DELETE FROM lm_index_vectors WHERE rowid = ?'
    ),
    deleteKeywords: database.prepare(
        'DELETE FROM lm_index_keywords WHERE memory_rowid = ?'
    ),
    insertKeyword: database.prepare(
        `INSERT INTO lm_index_keywords (memory_rowid, keyword)
         VALUES (?, ?)`
    ),
    countPreset: database.prepare(
        `SELECT COUNT(*) AS count
         FROM lm_index_memory
         WHERE preset_id = ?`
    )
})

type MutationStatements = ReturnType<typeof prepareMutationStatements>

const transaction = <T>(database: DatabaseSync, operation: () => T) => {
    database.exec('BEGIN')
    try {
        const result = operation()
        database.exec('COMMIT')
        return result
    } catch (error) {
        try {
            database.exec('ROLLBACK')
        } catch {}
        throw error
    }
}

export const countVectorIndexMemories = (database: DatabaseSync) => {
    const row = database
        .prepare('SELECT COUNT(*) AS count FROM lm_index_memory')
        .get() as unknown as CountRow
    return row.count
}

const countPresetMemories = (
    statements: MutationStatements,
    presetId: string
) => {
    const row = statements.countPreset.get(presetId) as unknown as CountRow
    return row.count
}

const deleteMemory = (
    statements: MutationStatements,
    presetId: string,
    memoryId: string
) => {
    const row = statements.selectMemoryInPreset.get(
        presetId,
        memoryId
    ) as unknown as MemoryRowId | undefined
    if (row === undefined) {
        return
    }
    statements.deleteVector.run(row.rowid)
    statements.deleteMemory.run(row.rowid)
}

const insertMemory = (
    statements: MutationStatements,
    upsert: Extract<VectorIndexUpsert, { vectorAction: 'replace' }>
) => {
    const document = upsert.document
    const result = statements.insertMemory.run(
        document.memoryId,
        document.presetId,
        document.status,
        document.type,
        toSqliteBoolean(document.isConsolidated),
        document.contentHash,
        document.keywordsHash,
        document.updatedAt
    )
    return Number(result.lastInsertRowid)
}

const updateMemory = (
    statements: MutationStatements,
    rowid: number,
    upsert: VectorIndexUpsert
) => {
    const document = upsert.document
    statements.updateMemory.run(
        document.presetId,
        document.status,
        document.type,
        toSqliteBoolean(document.isConsolidated),
        document.contentHash,
        document.keywordsHash,
        document.updatedAt,
        rowid
    )
}

const replaceVector = (
    statements: MutationStatements,
    rowid: number,
    upsert: Extract<VectorIndexUpsert, { vectorAction: 'replace' }>
) => {
    const document = upsert.document
    statements.deleteVector.run(rowid)
    statements.insertVector.run(
        BigInt(rowid),
        toSqliteVector(upsert.vector),
        document.presetId,
        document.status,
        document.type,
        toSqliteBoolean(document.isConsolidated)
    )
}

const updateVectorMetadata = (
    statements: MutationStatements,
    rowid: number,
    upsert: VectorIndexUpsert
) => {
    const document = upsert.document
    const result = statements.updateVector.run(
        document.status,
        document.type,
        toSqliteBoolean(document.isConsolidated),
        rowid
    )
    if (result.changes !== 1) {
        throw new Error(
            `cannot preserve missing vector: memory=${document.memoryId}`
        )
    }
}

const replaceKeywords = (
    statements: MutationStatements,
    rowid: number,
    keywords: string[]
) => {
    statements.deleteKeywords.run(rowid)
    for (const keyword of normalizeIndexKeywords(keywords)) {
        statements.insertKeyword.run(rowid, keyword)
    }
}

const upsertMemory = (
    statements: MutationStatements,
    upsert: VectorIndexUpsert
) => {
    const existing = statements.selectMemory.get(
        upsert.document.memoryId
    ) as unknown as MemoryRowId | undefined

    let rowid: number
    if (existing === undefined) {
        if (upsert.vectorAction === 'preserve') {
            throw new Error(
                `cannot preserve missing vector: memory=${upsert.document.memoryId}`
            )
        }
        rowid = insertMemory(statements, upsert)
    } else {
        rowid = existing.rowid
        updateMemory(statements, rowid, upsert)
    }

    if (upsert.vectorAction === 'replace') {
        replaceVector(statements, rowid, upsert)
    } else {
        updateVectorMetadata(statements, rowid, upsert)
    }
    replaceKeywords(statements, rowid, upsert.document.keywords)
}

export const applyVectorIndexMutation = (
    database: DatabaseSync,
    mutation: VectorIndexMutation
) => {
    const statements = prepareMutationStatements(database)
    return transaction(database, () => {
        for (const memoryId of mutation.deletes) {
            deleteMemory(statements, mutation.presetId, memoryId)
        }
        for (const upsert of mutation.upserts) {
            if (upsert.document.presetId !== mutation.presetId) {
                throw new Error(
                    `vector index mutation preset mismatch: batch=${mutation.presetId}, memory=${upsert.document.presetId}`
                )
            }
            upsertMemory(statements, upsert)
        }
        return {
            indexedCount: countPresetMemories(statements, mutation.presetId)
        }
    })
}

export const clearVectorIndexPreset = (
    database: DatabaseSync,
    presetId: string
) => {
    return transaction(database, () => {
        const rows = database
            .prepare(
                `SELECT rowid
                 FROM lm_index_memory
                 WHERE preset_id = ?`
            )
            .all(presetId) as unknown as MemoryRowId[]
        const deleteVector = database.prepare(
            'DELETE FROM lm_index_vectors WHERE rowid = ?'
        )
        for (const row of rows) {
            deleteVector.run(row.rowid)
        }
        database
            .prepare('DELETE FROM lm_index_memory WHERE preset_id = ?')
            .run(presetId)
        database
            .prepare('DELETE FROM lm_index_preset_state WHERE preset_id = ?')
            .run(presetId)
        return { deletedCount: rows.length }
    })
}

export const markVectorIndexPresetState = (
    database: DatabaseSync,
    status: MemoryVectorIndexPresetStatus
): MemoryVectorIndexPresetStatus => {
    database
        .prepare(
            `INSERT INTO lm_index_preset_state (
                preset_id,
                state,
                expected_count,
                indexed_count,
                last_error,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(preset_id) DO UPDATE SET
                state = excluded.state,
                expected_count = excluded.expected_count,
                indexed_count = excluded.indexed_count,
                last_error = excluded.last_error,
                updated_at = excluded.updated_at`
        )
        .run(
            status.presetId,
            status.state,
            status.expectedCount,
            status.indexedCount,
            status.lastError,
            status.updatedAt
        )
    return status
}
