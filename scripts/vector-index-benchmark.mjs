import { performance } from 'node:perf_hooks'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'

const memoryCount = Number(process.argv[2] ?? 5_000)
const dimension = Number(process.argv[3] ?? 1_536)
const queryCount = Number(process.argv[4] ?? 100)
const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), 'living-memory-vector-benchmark-')
)
const databasePath = resolve(temporaryDirectory, 'benchmark')
let database

let randomState = 0x6d2b79f5
const random = () => {
    randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState)
    randomState ^=
        randomState +
        Math.imul(randomState ^ (randomState >>> 7), 61 | randomState)
    return ((randomState ^ (randomState >>> 14)) >>> 0) / 4_294_967_296
}

const createVector = () => {
    const values = new Float32Array(dimension)
    let squaredNorm = 0
    for (let index = 0; index < dimension; index++) {
        const value = random() * 2 - 1
        values[index] = value
        squaredNorm += value * value
    }
    const norm = Math.sqrt(squaredNorm)
    for (let index = 0; index < dimension; index++) {
        values[index] /= norm
    }
    return `[${Array.from(values).join(',')}]`
}

const createMetadata = (index) => ({
    status: index % 5 === 0 ? 'archived' : 'active',
    type: index % 3 === 0 ? 'preference' : 'fact'
})

const directorySize = async (path) => {
    const entries = await readdir(path, { withFileTypes: true })
    return (
        await Promise.all(
            entries.map(async (entry) => {
                const entryPath = resolve(path, entry.name)
                return entry.isDirectory()
                    ? directorySize(entryPath)
                    : (await stat(entryPath)).size
            })
        )
    ).reduce((total, size) => total + size, 0)
}

try {
    database = new PGlite(databasePath, { extensions: { vector } })
    await database.exec('CREATE EXTENSION IF NOT EXISTS vector')
    await database.exec(`
        CREATE TABLE benchmark_vectors (
            id BIGINT PRIMARY KEY,
            embedding vector(${dimension}) NOT NULL,
            preset_id TEXT NOT NULL,
            status TEXT NOT NULL,
            type TEXT NOT NULL,
            is_consolidated BOOLEAN NOT NULL
        )
    `)
    const buildStartedAt = performance.now()
    await database.exec('BEGIN')
    try {
        for (let index = 1; index <= memoryCount; index++) {
            const metadata = createMetadata(index)
            await database.query(
                `INSERT INTO benchmark_vectors VALUES ($1, $2::vector, $3, $4, $5, $6)`,
                [
                    BigInt(index),
                    createVector(),
                    'benchmark-preset',
                    metadata.status,
                    metadata.type,
                    index % 2 === 1
                ]
            )
        }
        await database.exec('COMMIT')
    } catch (error) {
        try {
            await database.exec('ROLLBACK')
        } catch {}
        throw error
    }
    const buildDuration = performance.now() - buildStartedAt
    const queryDurations = []
    for (let index = 0; index < queryCount; index++) {
        const startedAt = performance.now()
        await database.query(
            `SELECT id, embedding <=> $1::vector AS distance
             FROM benchmark_vectors
             WHERE preset_id = $2 AND status = 'active' AND type = 'fact' AND is_consolidated = true
             ORDER BY embedding <=> $1::vector LIMIT 30`,
            [createVector(), 'benchmark-preset']
        )
        queryDurations.push(performance.now() - startedAt)
    }
    queryDurations.sort((left, right) => left - right)
    const p95Index = Math.ceil(queryDurations.length * 0.95) - 1
    await database.close()
    database = undefined

    const fileSize = await directorySize(databasePath)
    console.log(
        JSON.stringify(
            {
                memoryCount,
                dimension,
                queryCount,
                buildMilliseconds: Math.round(buildDuration),
                queryP95Milliseconds: Number(
                    queryDurations[p95Index].toFixed(3)
                ),
                fileMiB: Number((fileSize / 1024 / 1024).toFixed(2))
            },
            null,
            2
        )
    )
} finally {
    if (database !== undefined) {
        await database.close()
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
}
