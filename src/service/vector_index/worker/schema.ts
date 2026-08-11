import type { PGlite } from '@electric-sql/pglite'
import type { MemoryVectorIndexManifest } from '../../../contracts/vector_index'

export const VECTOR_INDEX_SCHEMA_VERSION = 2

const assertDimension = (dimension: number) => {
    if (!Number.isInteger(dimension) || dimension < 1) {
        throw new Error(`invalid vector index dimension: ${dimension}`)
    }
}

export const hasVectorIndexSchema = async (database: PGlite) => {
    const result = await database.query(
        `SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'lm_index_manifest'`
    )
    return result.rows.length > 0
}

export const createVectorIndexSchema = async (
    database: PGlite,
    manifest: MemoryVectorIndexManifest
) => {
    assertDimension(manifest.dimension)
    await database.exec(`
        CREATE TABLE lm_index_manifest (
            singleton integer PRIMARY KEY CHECK (singleton = 1),
            schema_version integer NOT NULL,
            embedding_model_id text NOT NULL,
            dimension integer NOT NULL,
            storage_engine text NOT NULL,
            vector_extension_version text NOT NULL,
            generation text NOT NULL,
            built_at bigint NOT NULL
        );

        CREATE TABLE lm_index_memory (
            memory_id text PRIMARY KEY,
            preset_id text NOT NULL,
            status text NOT NULL,
            type text NOT NULL,
            is_consolidated boolean NOT NULL,
            content_hash text NOT NULL,
            keywords_hash text NOT NULL,
            updated_at bigint NOT NULL,
            embedding vector(${manifest.dimension}) NOT NULL
        );

        CREATE INDEX lm_index_memory_preset_filter
        ON lm_index_memory (preset_id, status, type, is_consolidated);

        CREATE TABLE lm_index_keywords (
            memory_id text NOT NULL REFERENCES lm_index_memory(memory_id)
                ON DELETE CASCADE,
            keyword text NOT NULL,
            PRIMARY KEY (memory_id, keyword)
        );

        CREATE INDEX lm_index_keywords_lookup
        ON lm_index_keywords (keyword, memory_id);

        CREATE TABLE lm_index_preset_state (
            preset_id text PRIMARY KEY,
            state text NOT NULL,
            expected_count integer NOT NULL,
            indexed_count integer NOT NULL,
            last_error text,
            updated_at bigint NOT NULL
        );
    `)
    await database.query(
        `INSERT INTO lm_index_manifest (
            singleton,
            schema_version,
            embedding_model_id,
            dimension,
            storage_engine,
            vector_extension_version,
            generation,
            built_at
        ) VALUES (1, $1, $2, $3, $4, $5, $6, $7)`,
        [
            manifest.schemaVersion,
            manifest.embeddingModelId,
            manifest.dimension,
            manifest.storageEngine,
            manifest.vectorExtensionVersion,
            manifest.generation,
            manifest.builtAt
        ]
    )
}
