import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
    MemoryVectorIndexManifest,
    MemoryVectorIndexPresetStatus,
    MemoryVectorIndexState
} from '../../../contracts/vector_index'
import { summarizeError } from '../../shared/utils'
import { MirroredPGliteFilesystem } from './mirrored_filesystem'
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
import {
    analyzeVectorIndex,
    createVectorIndexSchema,
    hasVectorIndexSchema
} from './schema'

interface ManifestRow {
    schemaVersion: number
    embeddingModelId: string
    dimension: number
    storageEngine: MemoryVectorIndexManifest['storageEngine']
    vectorExtensionVersion: string
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

const removeDirectory = (directory: string) => {
    rmSync(directory, { recursive: true, force: true })
}

interface VectorIndexDatabaseOptions {
    removeDirectory?: (directory: string) => void
    reportWarning?: (warning: Error) => void
    analyze?: typeof analyzeVectorIndex
}

export class LivingMemoryVectorIndexDatabase {
    private filesystem: MirroredPGliteFilesystem | null = null
    private database: PGlite | null = null
    private activeDatabaseDirectory: string | null = null
    private rebuildDatabaseDirectory: string | null = null
    private mode: 'active' | 'rebuild' | null = null

    private readonly removeDatabaseDirectory: (directory: string) => void
    private readonly reportWarning: (warning: Error) => void
    private readonly analyze: typeof analyzeVectorIndex

    constructor(options: VectorIndexDatabaseOptions = {}) {
        this.removeDatabaseDirectory =
            options.removeDirectory ?? removeDirectory
        this.reportWarning =
            options.reportWarning ?? ((warning) => process.emitWarning(warning))
        this.analyze = options.analyze ?? analyzeVectorIndex
    }

    async open(
        databaseDirectory: string,
        previousDatabaseDirectory: string
    ): Promise<VectorIndexInspection> {
        if (this.database !== null) {
            throw new Error('vector index database is already open')
        }
        this.activeDatabaseDirectory = databaseDirectory
        if (
            !existsSync(databaseDirectory) &&
            existsSync(previousDatabaseDirectory)
        ) {
            renameSync(previousDatabaseDirectory, databaseDirectory)
        }

        let inspection: VectorIndexInspection
        try {
            this.database = await this.openConnection(databaseDirectory)
            this.mode = 'active'
            inspection = await this.inspect()
        } catch (error) {
            if (existsSync(previousDatabaseDirectory)) {
                return this.restorePreviousDatabase(
                    databaseDirectory,
                    previousDatabaseDirectory,
                    error
                )
            }
            await this.closeConnection()
            this.quarantineDatabaseDirectory(
                databaseDirectory,
                'database open',
                error
            )
            this.database = await this.openConnection(databaseDirectory)
            this.mode = 'active'
            return this.inspect()
        }

        if (existsSync(previousDatabaseDirectory)) {
            if (inspection.manifest === null) {
                return this.restorePreviousDatabase(
                    databaseDirectory,
                    previousDatabaseDirectory,
                    null
                )
            }
            this.cleanupDatabaseDirectory(
                previousDatabaseDirectory,
                'previous index cleanup after recovery'
            )
        }
        return inspection
    }

    async inspect(): Promise<VectorIndexInspection> {
        const database = this.requireDatabase()
        const vectorExtensionVersion =
            await this.readVectorExtensionVersion(database)
        if (!(await hasVectorIndexSchema(database))) {
            return {
                vectorExtensionVersion,
                manifest: null,
                indexedCount: 0,
                inventory: [],
                presets: []
            }
        }

        const manifest = (
            await database.query<ManifestRow>(
                `SELECT
                    schema_version AS "schemaVersion",
                    embedding_model_id AS "embeddingModelId",
                    dimension,
                    storage_engine AS "storageEngine",
                    vector_extension_version AS "vectorExtensionVersion",
                    generation,
                    built_at AS "builtAt"
                 FROM lm_index_manifest
                 WHERE singleton = 1`
            )
        ).rows[0]
        const presets = (
            await database.query<PresetStateRow>(
                `SELECT
                    preset_id AS "presetId",
                    state,
                    expected_count AS "expectedCount",
                    indexed_count AS "indexedCount",
                    last_error AS "lastError",
                    updated_at AS "updatedAt"
                 FROM lm_index_preset_state
                 ORDER BY preset_id ASC`
            )
        ).rows
        const inventory = (
            await database.query<{ presetId: string; indexedCount: string }>(
                `SELECT preset_id AS "presetId", COUNT(*)::text AS "indexedCount"
                 FROM lm_index_memory
                 GROUP BY preset_id
                 ORDER BY preset_id ASC`
            )
        ).rows.map((row) => ({
            presetId: row.presetId,
            indexedCount: Number(row.indexedCount)
        }))

        return {
            vectorExtensionVersion,
            manifest: manifest === undefined ? null : manifest,
            indexedCount: await countVectorIndexMemories(database),
            inventory,
            presets: presets.map((preset) => ({
                ...preset,
                expectedCount: Number(preset.expectedCount),
                indexedCount: Number(preset.indexedCount),
                updatedAt: Number(preset.updatedAt)
            }))
        }
    }

    async openCandidate(databaseDirectory: string) {
        if (this.database !== null) {
            throw new Error('vector index database is already open')
        }
        this.activeDatabaseDirectory = databaseDirectory
        try {
            this.database = await this.openConnection(databaseDirectory)
            this.mode = 'active'
            return await this.inspect()
        } catch (error) {
            await this.closeConnection()
            this.mode = null
            throw error
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
    async applyMutation(mutation: VectorIndexMutation) {
        const result = await applyVectorIndexMutation(
            this.requireDatabase(),
            mutation
        )
        await this.checkpoint()
        return result
    }
    async clearPreset(presetId: string) {
        const result = await clearVectorIndexPreset(
            this.requireDatabase(),
            presetId
        )
        await this.checkpoint()
        return result
    }

    readInventoryPage(
        presetId: string | null,
        afterMemoryId: string | null,
        limit: number
    ) {
        return readVectorIndexInventoryPage(
            this.requireDatabase(),
            presetId,
            afterMemoryId,
            limit
        )
    }
    async markPresetState(status: MemoryVectorIndexPresetStatus) {
        const result = await markVectorIndexPresetState(
            this.requireDatabase(),
            status
        )
        await this.checkpoint()
        return result
    }

    async createRebuildFile(
        databaseDirectory: string,
        manifest: MemoryVectorIndexManifest
    ): Promise<VectorIndexInspection> {
        if (existsSync(databaseDirectory)) {
            throw new Error(
                `vector index rebuild directory already exists: ${databaseDirectory}`
            )
        }
        const activeDirectory = this.requireActiveDatabaseDirectory()
        await this.closeConnection()
        try {
            this.database = await this.openConnection(databaseDirectory)
            await createVectorIndexSchema(this.database, manifest)
            await this.checkpoint()
            this.rebuildDatabaseDirectory = databaseDirectory
            this.mode = 'rebuild'
            return this.inspect()
        } catch (error) {
            await this.closeConnection()
            removeDirectory(databaseDirectory)
            this.database = await this.openConnection(activeDirectory)
            this.mode = 'active'
            throw error
        }
    }
    async appendRebuildBatch(
        presetId: string,
        upserts: VectorIndexReplaceUpsert[]
    ) {
        const result = await applyVectorIndexMutation(
            this.requireRebuildDatabase(),
            {
                presetId,
                upserts,
                deletes: []
            }
        )
        await this.checkpoint()
        return result
    }

    async prepareRebuild(expectedCount: number) {
        const database = this.requireRebuildDatabase()
        const indexedCount = await countVectorIndexMemories(database)
        if (indexedCount !== expectedCount) {
            throw new Error(
                `vector index rebuild count mismatch: expected=${expectedCount}, actual=${indexedCount}`
            )
        }
        await this.analyze(database)
        await this.closeConnection()
        this.mode = null
        return { indexedCount }
    }

    async abortRebuild(): Promise<VectorIndexInspection> {
        if (this.mode === 'active') {
            return this.inspect()
        }
        const activeDirectory = this.requireActiveDatabaseDirectory()
        const rebuildDirectory = this.requireRebuildDatabaseDirectory()
        await this.closeConnection()
        removeDirectory(rebuildDirectory)
        this.rebuildDatabaseDirectory = null
        this.database = await this.openConnection(activeDirectory)
        this.mode = 'active'
        return this.inspect()
    }

    async dispose() {
        await this.closeConnection()
        this.activeDatabaseDirectory = null
        this.rebuildDatabaseDirectory = null
        this.mode = null
    }

    private async checkpoint() {
        if (this.filesystem !== null) {
            await this.filesystem.checkpoint()
        }
    }

    private async openConnection(directory: string) {
        mkdirSync(dirname(directory), { recursive: true })
        const filesystem = new MirroredPGliteFilesystem(directory)
        const database = await PGlite.create({
            fs: filesystem,
            extensions: { vector }
        })
        try {
            await database.exec('CREATE EXTENSION IF NOT EXISTS vector')
            this.filesystem = filesystem
            await this.checkpoint()
            return database
        } catch (error) {
            this.filesystem = null
            await database.close()
            throw error
        }
    }

    private async restorePreviousDatabase(
        databaseDirectory: string,
        previousDatabaseDirectory: string,
        currentDirectoryError: unknown | null
    ) {
        await this.closeConnection()
        if (currentDirectoryError !== null) {
            this.quarantineDatabaseDirectory(
                databaseDirectory,
                'database recovery',
                currentDirectoryError
            )
        } else {
            this.removeDatabaseDirectory(databaseDirectory)
        }
        renameSync(previousDatabaseDirectory, databaseDirectory)
        this.database = await this.openConnection(databaseDirectory)
        this.mode = 'active'
        return this.inspect()
    }

    private async closeConnection() {
        if (this.database !== null) {
            const database = this.database
            this.database = null
            try {
                await this.checkpoint()
            } finally {
                this.filesystem = null
                await database.close()
            }
        }
    }

    private quarantineDatabaseDirectory(
        directory: string,
        operation: string,
        cause: unknown
    ) {
        if (!existsSync(directory)) {
            return
        }
        const quarantineDirectory = `${directory}.failed-${randomUUID()}`
        renameSync(directory, quarantineDirectory)
        this.reportWarning(
            new Error(
                `vector index database quarantined: operation=${operation} ` +
                    `source=${directory} quarantine=${quarantineDirectory}: ` +
                    summarizeError(cause),
                { cause }
            )
        )
    }

    private cleanupDatabaseDirectory(directory: string, operation: string) {
        try {
            this.removeDatabaseDirectory(directory)
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error)
            this.reportWarning(
                new Error(
                    `vector index cleanup failed: operation=${operation} ` +
                        `directory=${directory}: ${message}`,
                    { cause: error }
                )
            )
        }
    }

    private requireDatabase() {
        if (this.database === null) {
            throw new Error('vector index database is not open')
        }
        return this.database
    }

    private requireActiveDatabase() {
        const database = this.requireDatabase()
        if (this.mode !== 'active') {
            throw new Error('vector index database is rebuilding')
        }
        return database
    }

    private requireRebuildDatabase() {
        const database = this.requireDatabase()
        if (this.mode !== 'rebuild') {
            throw new Error('vector index rebuild is not active')
        }
        return database
    }

    private requireActiveDatabaseDirectory() {
        if (this.activeDatabaseDirectory === null) {
            throw new Error('vector index active directory is not set')
        }
        return this.activeDatabaseDirectory
    }

    private requireRebuildDatabaseDirectory() {
        if (this.rebuildDatabaseDirectory === null) {
            throw new Error('vector index rebuild directory is not set')
        }
        return this.rebuildDatabaseDirectory
    }

    private async readVectorExtensionVersion(database: PGlite) {
        const row = (
            await database.query<{ extversion: string }>(
                `SELECT extversion
                 FROM pg_extension
                 WHERE extname = 'vector'`
            )
        ).rows[0]
        if (row === undefined) {
            throw new Error('pgvector extension is not loaded')
        }
        return row.extversion
    }
}
