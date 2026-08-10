import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import * as sqliteVec from 'sqlite-vec'
import type {
    MemoryVectorIndexManifest,
    MemoryVectorIndexPresetStatus,
    MemoryVectorIndexState
} from '../../../contracts/vector_index'
import type {
    VectorIndexHybridQuery,
    VectorIndexInspection,
    VectorIndexKnnQuery,
    VectorIndexMutation,
    VectorIndexReplaceUpsert
} from '../worker_protocol'
import {
    applyVectorIndexMutation,
    clearVectorIndexPreset,
    countVectorIndexMemories,
    markVectorIndexPresetState
} from './mutations'
import {
    queryVectorIndexHybrid,
    queryVectorIndexKnn,
    readVectorIndexInventoryPage,
    readVectorIndexVectors
} from './queries'
import { createVectorIndexSchema, hasVectorIndexSchema } from './schema'

interface ManifestRow {
    schemaVersion: number
    embeddingModelId: string
    dimension: number
    sqliteVecVersion: string
    generation: string
    builtAt: number
}

interface PresetStateRow {
    presetId: string
    state: MemoryVectorIndexState
    expectedCount: number
    indexedCount: number
    lastError: string | null
    updatedAt: number
}

interface PresetInventoryRow {
    presetId: string
    indexedCount: number
}

export class LivingMemoryVectorIndexDatabase {
    private database: DatabaseSync | null = null
    private sqliteVecVersion: string | null = null
    private formalDatabasePath: string | null = null
    private rebuildDatabasePath: string | null = null
    private mode: 'active' | 'rebuild' | null = null

    open(
        databasePath: string,
        previousDatabasePath: string
    ): VectorIndexInspection {
        if (this.database !== null) {
            throw new Error('vector index database is already open')
        }

        this.formalDatabasePath = databasePath
        if (!existsSync(databasePath) && existsSync(previousDatabasePath)) {
            renameSync(previousDatabasePath, databasePath)
        }

        try {
            this.database = this.openConnection(databasePath)
            this.mode = 'active'
            const inspection = this.inspect()
            if (existsSync(previousDatabasePath)) {
                if (inspection.manifest === null) {
                    return this.restorePreviousDatabase(
                        databasePath,
                        previousDatabasePath
                    )
                }
                unlinkSync(previousDatabasePath)
            }
            return inspection
        } catch (error) {
            if (!existsSync(previousDatabasePath)) {
                this.closeConnection()
                throw error
            }
            return this.restorePreviousDatabase(
                databasePath,
                previousDatabasePath
            )
        }
    }

    inspect(): VectorIndexInspection {
        const database = this.requireDatabase()
        const sqliteVecVersion = this.requireSqliteVecVersion()
        if (!hasVectorIndexSchema(database)) {
            return {
                sqliteVecVersion,
                manifest: null,
                indexedCount: 0,
                inventory: [],
                presets: []
            }
        }

        const manifestRow = database
            .prepare(
                `SELECT
                    schema_version AS schemaVersion,
                    embedding_model_id AS embeddingModelId,
                    dimension,
                    sqlite_vec_version AS sqliteVecVersion,
                    generation,
                    built_at AS builtAt
                 FROM lm_index_manifest
                 WHERE singleton = 1`
            )
            .get() as unknown as ManifestRow | undefined
        const presets = database
            .prepare(
                `SELECT
                    preset_id AS presetId,
                    state,
                    expected_count AS expectedCount,
                    indexed_count AS indexedCount,
                    last_error AS lastError,
                    updated_at AS updatedAt
                 FROM lm_index_preset_state
                 ORDER BY preset_id ASC`
            )
            .all() as unknown as PresetStateRow[]
        const inventory = database
            .prepare(
                `SELECT
                    preset_id AS presetId,
                    COUNT(*) AS indexedCount
                 FROM lm_index_memory
                 GROUP BY preset_id
                 ORDER BY preset_id ASC`
            )
            .all() as unknown as PresetInventoryRow[]
        let manifest: MemoryVectorIndexManifest | null = null
        if (manifestRow !== undefined) {
            manifest = manifestRow
        }

        return {
            sqliteVecVersion,
            manifest,
            indexedCount: countVectorIndexMemories(database),
            inventory,
            presets
        }
    }

    queryKnn(query: VectorIndexKnnQuery) {
        return queryVectorIndexKnn(this.requireActiveDatabase(), query)
    }

    queryHybrid(query: VectorIndexHybridQuery) {
        return queryVectorIndexHybrid(this.requireActiveDatabase(), query)
    }

    readVectors(presetId: string, memoryIds: string[]) {
        return readVectorIndexVectors(
            this.requireActiveDatabase(),
            presetId,
            memoryIds
        )
    }

    applyMutation(mutation: VectorIndexMutation) {
        return applyVectorIndexMutation(this.requireSchemaDatabase(), mutation)
    }

    clearPreset(presetId: string) {
        return clearVectorIndexPreset(this.requireSchemaDatabase(), presetId)
    }

    readInventoryPage(
        presetId: string | null,
        afterMemoryId: string | null,
        limit: number
    ) {
        return readVectorIndexInventoryPage(
            this.requireSchemaDatabase(),
            presetId,
            afterMemoryId,
            limit
        )
    }

    markPresetState(status: MemoryVectorIndexPresetStatus) {
        return markVectorIndexPresetState(this.requireSchemaDatabase(), status)
    }

    createRebuildFile(
        databasePath: string,
        manifest: MemoryVectorIndexManifest
    ): VectorIndexInspection {
        const formalDatabasePath = this.requireFormalDatabasePath()
        if (this.database !== null && this.mode !== 'active') {
            throw new Error('vector index database is rebuilding')
        }
        if (existsSync(databasePath)) {
            throw new Error(
                `vector index rebuild file already exists: ${databasePath}`
            )
        }

        this.closeConnection()
        try {
            this.database = this.openConnection(databasePath)
            createVectorIndexSchema(this.database, manifest)
            this.rebuildDatabasePath = databasePath
            this.mode = 'rebuild'
            return this.inspect()
        } catch (error) {
            this.closeConnection()
            if (existsSync(databasePath)) {
                unlinkSync(databasePath)
            }
            this.database = this.openConnection(formalDatabasePath)
            this.mode = 'active'
            throw error
        }
    }

    appendRebuildBatch(presetId: string, upserts: VectorIndexReplaceUpsert[]) {
        return applyVectorIndexMutation(this.requireRebuildDatabase(), {
            presetId,
            upserts,
            deletes: []
        })
    }

    finalizeRebuild(
        previousDatabasePath: string,
        expectedCount: number
    ): VectorIndexInspection {
        const database = this.requireRebuildDatabase()
        const formalDatabasePath = this.requireFormalDatabasePath()
        const rebuildDatabasePath = this.requireRebuildDatabasePath()
        const indexedCount = countVectorIndexMemories(database)
        if (indexedCount !== expectedCount) {
            throw new Error(
                `vector index rebuild count mismatch: ` +
                    `expected=${expectedCount}, actual=${indexedCount}`
            )
        }
        if (existsSync(previousDatabasePath)) {
            throw new Error(
                `vector index previous file already exists: ${previousDatabasePath}`
            )
        }

        this.closeConnection()
        let formalMoved = false
        let rebuildMoved = false
        try {
            if (existsSync(formalDatabasePath)) {
                renameSync(formalDatabasePath, previousDatabasePath)
                formalMoved = true
            }
            renameSync(rebuildDatabasePath, formalDatabasePath)
            rebuildMoved = true
            this.database = this.openConnection(formalDatabasePath)
            this.mode = 'active'
            this.rebuildDatabasePath = null
            const inspection = this.inspect()
            if (existsSync(previousDatabasePath)) {
                unlinkSync(previousDatabasePath)
            }
            return inspection
        } catch (error) {
            this.closeConnection()
            if (rebuildMoved && existsSync(formalDatabasePath)) {
                renameSync(formalDatabasePath, rebuildDatabasePath)
            }
            if (formalMoved && existsSync(previousDatabasePath)) {
                renameSync(previousDatabasePath, formalDatabasePath)
            }
            if (existsSync(rebuildDatabasePath)) {
                unlinkSync(rebuildDatabasePath)
            }
            this.database = this.openConnection(formalDatabasePath)
            this.mode = 'active'
            this.rebuildDatabasePath = null
            throw error
        }
    }

    abortRebuild(): VectorIndexInspection {
        if (this.mode === 'active') {
            return this.inspect()
        }
        this.requireRebuildDatabase()
        const formalDatabasePath = this.requireFormalDatabasePath()
        const rebuildDatabasePath = this.requireRebuildDatabasePath()
        this.closeConnection()
        unlinkSync(rebuildDatabasePath)
        this.rebuildDatabasePath = null
        this.database = this.openConnection(formalDatabasePath)
        this.mode = 'active'
        return this.inspect()
    }

    dispose() {
        this.closeConnection()
        this.formalDatabasePath = null
        this.rebuildDatabasePath = null
        this.mode = null
        this.sqliteVecVersion = null
    }

    private openConnection(databasePath: string) {
        mkdirSync(dirname(databasePath), { recursive: true })
        const database = new DatabaseSync(databasePath, {
            allowExtension: true
        })
        try {
            database.exec('PRAGMA foreign_keys = ON')
            database.exec('PRAGMA journal_mode = DELETE')
            database.exec('PRAGMA synchronous = NORMAL')
            sqliteVec.load(database)
            const versionRow = database
                .prepare('SELECT vec_version() AS version')
                .get() as { version: string }
            this.sqliteVecVersion = versionRow.version
            return database
        } catch (error) {
            database.close()
            throw error
        }
    }

    private restorePreviousDatabase(
        databasePath: string,
        previousDatabasePath: string
    ) {
        this.closeConnection()
        if (existsSync(databasePath)) {
            unlinkSync(databasePath)
        }
        renameSync(previousDatabasePath, databasePath)
        this.database = this.openConnection(databasePath)
        this.mode = 'active'
        return this.inspect()
    }

    private closeConnection() {
        if (this.database !== null) {
            this.database.close()
            this.database = null
        }
    }

    private requireDatabase() {
        if (this.database === null) {
            throw new Error('vector index database is not open')
        }
        return this.database
    }

    private requireSchemaDatabase() {
        const database = this.requireDatabase()
        if (!hasVectorIndexSchema(database)) {
            throw new Error('vector index schema is not initialized')
        }
        return database
    }

    private requireActiveDatabase() {
        const database = this.requireSchemaDatabase()
        if (this.mode !== 'active') {
            throw new Error('vector index database is rebuilding')
        }
        return database
    }

    private requireRebuildDatabase() {
        const database = this.requireSchemaDatabase()
        if (this.mode !== 'rebuild') {
            throw new Error('vector index rebuild is not active')
        }
        return database
    }

    private requireFormalDatabasePath() {
        if (this.formalDatabasePath === null) {
            throw new Error('vector index formal database path is not set')
        }
        return this.formalDatabasePath
    }

    private requireRebuildDatabasePath() {
        if (this.rebuildDatabasePath === null) {
            throw new Error('vector index rebuild database path is not set')
        }
        return this.rebuildDatabasePath
    }

    private requireSqliteVecVersion() {
        if (this.sqliteVecVersion === null) {
            throw new Error('sqlite-vec extension is not loaded')
        }
        return this.sqliteVecVersion
    }
}
