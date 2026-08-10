import { performance } from 'node:perf_hooks'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as sqliteVec from 'sqlite-vec'

const memoryCount = Number(process.argv[2] ?? 5_000)
const dimension = Number(process.argv[3] ?? 1_536)
const queryCount = Number(process.argv[4] ?? 100)
const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), 'living-memory-vector-benchmark-')
)
const databasePath = resolve(temporaryDirectory, 'benchmark.sqlite')
let database

let randomState = 0x6d2b79f5
const random = () => {
    randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState)
    randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState)
    return ((randomState ^ (randomState >>> 14)) >>> 0) / 4_294_967_296
}

const createVector = () => {
    const vector = new Float32Array(dimension)
    let squaredNorm = 0
    for (let index = 0; index < dimension; index++) {
        const value = random() * 2 - 1
        vector[index] = value
        squaredNorm += value * value
    }
    const norm = Math.sqrt(squaredNorm)
    for (let index = 0; index < dimension; index++) {
        vector[index] /= norm
    }
    return new Uint8Array(vector.buffer)
}

const createMetadata = (index) => {
    let status = 'active'
    if (index % 5 === 0) {
        status = 'archived'
    }
    let type = 'fact'
    if (index % 3 === 0) {
        type = 'preference'
    }
    return { status, type }
}

try {
    database = new DatabaseSync(databasePath, { allowExtension: true })
    sqliteVec.load(database)
    database.exec('PRAGMA journal_mode = DELETE')
    database.exec('PRAGMA synchronous = NORMAL')
    database.exec(`
        CREATE VIRTUAL TABLE benchmark_vectors USING vec0(
            embedding FLOAT[${dimension}] distance_metric=cosine,
            preset_id TEXT PARTITION KEY,
            status TEXT,
            type TEXT,
            is_consolidated BOOLEAN
        )
    `)
    const insert = database.prepare(
        `INSERT INTO benchmark_vectors (
            rowid,
            embedding,
            preset_id,
            status,
            type,
            is_consolidated
        ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    const buildStartedAt = performance.now()
    database.exec('BEGIN')
    try {
        for (let index = 1; index <= memoryCount; index++) {
            const metadata = createMetadata(index)
            insert.run(
                BigInt(index),
                createVector(),
                'benchmark-preset',
                metadata.status,
                metadata.type,
                BigInt(index % 2)
            )
        }
        database.exec('COMMIT')
    } catch (error) {
        try {
            database.exec('ROLLBACK')
        } catch {}
        throw error
    }
    const buildDuration = performance.now() - buildStartedAt
    const query = database.prepare(
        `SELECT rowid, distance
         FROM benchmark_vectors
         WHERE embedding MATCH ?
           AND k = 30
           AND preset_id = 'benchmark-preset'
           AND status = 'active'
           AND type = 'fact'
           AND is_consolidated = 1
         ORDER BY distance ASC`
    )
    const queryDurations = []
    for (let index = 0; index < queryCount; index++) {
        const startedAt = performance.now()
        query.all(createVector())
        queryDurations.push(performance.now() - startedAt)
    }
    queryDurations.sort((left, right) => left - right)
    const p95Index = Math.ceil(queryDurations.length * 0.95) - 1
    const file = await stat(databasePath)
    database.close()
    database = undefined

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
                fileMiB: Number((file.size / 1024 / 1024).toFixed(2))
            },
            null,
            2
        )
    )
} finally {
    if (database !== undefined) {
        database.close()
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
}
