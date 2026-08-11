import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), 'living-memory-vector-smoke-')
)
const databasePath = resolve(temporaryDirectory, 'native')
const database = new PGlite(databasePath, { extensions: { vector } })

const waitForWorkerCall = (worker, id, command) => {
    return new Promise((resolveCall, rejectCall) => {
        const handleMessage = (response) => {
            if (response.id !== id) {
                return
            }
            worker.off('message', handleMessage)
            worker.off('error', rejectCall)
            if (response.ok) {
                resolveCall(response.result)
            } else {
                rejectCall(new Error(response.error.message))
            }
        }
        worker.on('message', handleMessage)
        worker.once('error', rejectCall)
        worker.postMessage({ id, command })
    })
}

try {
    await database.exec('CREATE EXTENSION IF NOT EXISTS vector')
    const version = await database.query(
        "SELECT extversion AS version FROM pg_extension WHERE extname = 'vector'"
    )
    assert.equal(typeof version.rows[0].version, 'string')

    await database.exec(`
        CREATE TABLE smoke_vectors (
            id BIGINT PRIMARY KEY,
            embedding vector(3) NOT NULL,
            preset_id TEXT NOT NULL,
            status TEXT NOT NULL,
            type TEXT NOT NULL,
            is_consolidated BOOLEAN NOT NULL
        )
    `)
    await database.query(
        `INSERT INTO smoke_vectors VALUES
         (1, $1::vector, 'preset-a', 'active', 'fact', true),
         (2, $2::vector, 'preset-a', 'active', 'fact', false),
         (3, $1::vector, 'preset-b', 'active', 'fact', true)`,
        ['[1,0,0]', '[0,1,0]']
    )
    const nearest = await database.query(
        `SELECT id, embedding <=> $1::vector AS distance
         FROM smoke_vectors
         WHERE preset_id = 'preset-a'
           AND status = 'active'
           AND type = 'fact'
           AND is_consolidated = true
         ORDER BY embedding <=> $1::vector
         LIMIT 10`,
        ['[1,0,0]']
    )
    assert.deepEqual(
        nearest.rows.map((row) => row.id),
        [1]
    )
    assert.ok(Number(nearest.rows[0].distance) < 0.000_001)

    await database.query(
        `UPDATE smoke_vectors
         SET status = 'archived', is_consolidated = false
         WHERE id = 1`
    )
    const updated = await database.query(
        `SELECT id FROM smoke_vectors
         WHERE embedding <=> $1::vector >= 0
           AND preset_id = 'preset-a'
           AND status = 'archived'
           AND is_consolidated = false`,
        ['[1,0,0]']
    )
    assert.deepEqual(
        updated.rows.map((row) => row.id),
        [1]
    )

    await database.query('DELETE FROM smoke_vectors WHERE id = 1')
    const count = await database.query(
        'SELECT COUNT(*)::int AS count FROM smoke_vectors'
    )
    assert.equal(count.rows[0].count, 2)
    const cjsEntry = resolve(projectRoot, 'lib', 'index.cjs')
    const require = createRequire(import.meta.url)
    require(cjsEntry)

    const workerPath = resolve(dirname(cjsEntry), 'vector-index-worker.mjs')
    const worker = new Worker(workerPath)
    const exitPromise = new Promise((resolveExit) => {
        worker.once('exit', resolveExit)
    })
    const inspection = await waitForWorkerCall(worker, 1, {
        type: 'open',
        databaseDirectory: resolve(temporaryDirectory, 'worker'),
        previousDatabaseDirectory: resolve(
            temporaryDirectory,
            'worker.previous'
        )
    })
    assert.equal(inspection.manifest, null)
    assert.equal(inspection.vectorExtensionVersion, version.rows[0].version)
    const manifest = {
        schemaVersion: 2,
        embeddingModelId: 'smoke-model',
        dimension: 3,
        storageEngine: 'pglite-pgvector',
        vectorExtensionVersion: inspection.vectorExtensionVersion,
        generation: 'smoke-generation',
        builtAt: Date.now()
    }
    const created = await waitForWorkerCall(worker, 2, {
        type: 'createRebuildFile',
        databaseDirectory: resolve(temporaryDirectory, 'worker.rebuild'),
        manifest
    })
    assert.deepEqual(created.manifest, manifest)
    await waitForWorkerCall(worker, 3, { type: 'dispose' })
    assert.equal(await exitPromise, 0)

    console.log(
        `PGlite pgvector ${version.rows[0].version} native smoke passed`
    )
} finally {
    await database.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
}
