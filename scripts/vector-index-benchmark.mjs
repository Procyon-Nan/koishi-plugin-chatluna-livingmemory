import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { createBenchmarkConfiguration } from './vector-index-benchmark-options.mjs'
import {
    createMemory,
    createMemorySampler,
    createQueryVectors,
    createRandom,
    directorySize,
    measureCpu,
    runWorkload,
    toPgVector
} from './vector-index-benchmark-support.mjs'

const require = createRequire(import.meta.url)
require('esbuild-register/dist/node').register()
const {
    VECTOR_INDEX_SCHEMA_VERSION,
    createVectorIndexSchema
} = require('../src/service/vector_index/worker/schema.ts')
const {
    queryVectorIndexHybrid,
    queryVectorIndexKnn
} = require('../src/service/vector_index/worker/queries.ts')

const { options, selectedWorkloads, memoryTypeDistribution } =
    createBenchmarkConfiguration(process.argv.slice(2))
const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), 'living-memory-vector-benchmark-')
)
const databasePath = resolve(temporaryDirectory, 'benchmark')
const dataRandom = createRandom(options.seed)
const queryRandom = createRandom(options.seed ^ 0x9e3779b9)
const queryVectors = createQueryVectors(options, queryRandom)
const memorySampler = createMemorySampler()
let database
let memoryMetrics

try {
    const schemaStartedAt = performance.now()
    database = new PGlite(databasePath, { extensions: { vector } })
    await database.exec('CREATE EXTENSION IF NOT EXISTS vector')
    const extension = await database.query(
        `SELECT extversion
         FROM pg_extension
         WHERE extname = 'vector'`
    )
    const vectorExtensionVersion = extension.rows[0].extversion
    await createVectorIndexSchema(database, {
        schemaVersion: VECTOR_INDEX_SCHEMA_VERSION,
        embeddingModelId: 'benchmark-embedding-model',
        dimension: options.dimension,
        storageEngine: 'pglite-pgvector',
        vectorExtensionVersion,
        generation: 'benchmark-generation',
        builtAt: 1_700_000_000_000
    })
    const schemaMilliseconds = performance.now() - schemaStartedAt

    const buildCpuStartedAt = process.cpuUsage()
    const buildStartedAt = performance.now()
    await database.exec('BEGIN')
    try {
        for (let index = 1; index <= options.memoryCount; index++) {
            const memory = createMemory(
                index,
                options,
                memoryTypeDistribution,
                dataRandom
            )
            await database.query(
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
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
                [
                    memory.id,
                    memory.presetId,
                    memory.status,
                    memory.type,
                    memory.isConsolidated,
                    memory.contentHash,
                    memory.keywordsHash,
                    memory.updatedAt,
                    toPgVector(memory.vector)
                ]
            )
            await database.query(
                `INSERT INTO lm_index_keywords (memory_id, keyword)
                 SELECT $1, UNNEST($2::text[])`,
                [memory.id, memory.keywords]
            )
            memorySampler.sample()
        }
        await database.exec('COMMIT')
    } catch (error) {
        try {
            await database.exec('ROLLBACK')
        } catch {}
        throw error
    }
    const buildMilliseconds = performance.now() - buildStartedAt
    const buildCpuMilliseconds = measureCpu(buildCpuStartedAt)

    let analyzeMilliseconds = null
    if (options.analyze) {
        const analyzeStartedAt = performance.now()
        await database.exec('ANALYZE lm_index_memory')
        await database.exec('ANALYZE lm_index_keywords')
        analyzeMilliseconds = performance.now() - analyzeStartedAt
    }

    const workloads = {}
    for (const workload of selectedWorkloads) {
        workloads[workload] = await runWorkload({
            database,
            options,
            name: workload,
            queryVectors,
            memorySampler,
            queryVectorIndexHybrid,
            queryVectorIndexKnn
        })
    }

    await database.close()
    database = undefined
    memoryMetrics = memorySampler.stop()
    const fileSize = await directorySize(databasePath)
    console.log(
        JSON.stringify(
            {
                config: options,
                schema: {
                    schemaVersion: VECTOR_INDEX_SCHEMA_VERSION,
                    storageEngine: 'pglite-pgvector',
                    vectorExtensionVersion
                },
                build: {
                    schemaMilliseconds: Number(schemaMilliseconds.toFixed(3)),
                    dataMilliseconds: Number(buildMilliseconds.toFixed(3)),
                    cpuMilliseconds: buildCpuMilliseconds,
                    analyzeMilliseconds:
                        analyzeMilliseconds === null
                            ? null
                            : Number(analyzeMilliseconds.toFixed(3)),
                    databaseFileMiB: Number((fileSize / 1024 / 1024).toFixed(2))
                },
                memory: {
                    baselineRssMiB: Number(
                        (memoryMetrics.baselineRss / 1024 / 1024).toFixed(2)
                    ),
                    peakRssMiB: Number(
                        (memoryMetrics.peakRss / 1024 / 1024).toFixed(2)
                    )
                },
                workloads
            },
            null,
            2
        )
    )
} finally {
    try {
        if (database !== undefined) {
            await database.close()
        }
    } finally {
        if (memoryMetrics === undefined) {
            memorySampler.stop()
        }
        await rm(temporaryDirectory, { recursive: true, force: true })
    }
}
