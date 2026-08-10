import type { DatabaseSync } from 'node:sqlite'
import type { MemoryVectorIndexManifest } from '../../../contracts/vector_index'

export const VECTOR_INDEX_SCHEMA_VERSION = 1

const assertDimension = (dimension: number) => {
    if (!Number.isInteger(dimension) || dimension < 1) {
        throw new Error(`invalid vector index dimension: ${dimension}`)
    }
}

export const hasVectorIndexSchema = (database: DatabaseSync) => {
    const row = database
        .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name = 'lm_index_manifest'`
        )
        .get()
    return row !== undefined
}

export const createVectorIndexSchema = (
    database: DatabaseSync,
    manifest: MemoryVectorIndexManifest
) => {
    assertDimension(manifest.dimension)

    database.exec(`
        CREATE TABLE lm_index_manifest (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            schema_version INTEGER NOT NULL,
            embedding_model_id TEXT NOT NULL,
            dimension INTEGER NOT NULL,
            sqlite_vec_version TEXT NOT NULL,
            generation TEXT NOT NULL,
            built_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE lm_index_memory (
            rowid INTEGER PRIMARY KEY,
            memory_id TEXT NOT NULL UNIQUE,
            preset_id TEXT NOT NULL,
            status TEXT NOT NULL,
            type TEXT NOT NULL,
            is_consolidated INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            keywords_hash TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX lm_index_memory_preset_filter
        ON lm_index_memory (preset_id, status, type, is_consolidated);

        CREATE VIRTUAL TABLE lm_index_vectors USING vec0(
            embedding FLOAT[${manifest.dimension}] distance_metric=cosine,
            preset_id TEXT PARTITION KEY,
            status TEXT,
            type TEXT,
            is_consolidated BOOLEAN
        );

        CREATE TABLE lm_index_keywords (
            memory_rowid INTEGER NOT NULL,
            keyword TEXT NOT NULL COLLATE NOCASE,
            PRIMARY KEY (memory_rowid, keyword),
            FOREIGN KEY (memory_rowid)
                REFERENCES lm_index_memory(rowid)
                ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX lm_index_keywords_lookup
        ON lm_index_keywords (keyword, memory_rowid);

        CREATE TABLE lm_index_preset_state (
            preset_id TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            expected_count INTEGER NOT NULL,
            indexed_count INTEGER NOT NULL,
            last_error TEXT,
            updated_at INTEGER NOT NULL
        ) STRICT;
    `)

    database
        .prepare(
            `INSERT INTO lm_index_manifest (
                singleton,
                schema_version,
                embedding_model_id,
                dimension,
                sqlite_vec_version,
                generation,
                built_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            manifest.schemaVersion,
            manifest.embeddingModelId,
            manifest.dimension,
            manifest.sqliteVecVersion,
            manifest.generation,
            manifest.builtAt
        )
}
