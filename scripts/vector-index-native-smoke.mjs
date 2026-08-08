import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), 'living-memory-vector-smoke-')
)
const database = new Database(resolve(temporaryDirectory, 'native.sqlite'))

const toBlob = (values) => {
    const vector = new Float32Array(values)
    return new Uint8Array(vector.buffer)
}

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
    sqliteVec.load(database)
    const version = database.prepare('SELECT vec_version() AS version').get()
    assert.equal(typeof version.version, 'string')

    database.exec(`
        CREATE VIRTUAL TABLE smoke_vectors USING vec0(
            embedding FLOAT[3] distance_metric=cosine,
            preset_id TEXT PARTITION KEY,
            status TEXT,
            type TEXT,
            is_consolidated BOOLEAN
        )
    `)
    const insert = database.prepare(
        `INSERT INTO smoke_vectors (
            rowid,
            embedding,
            preset_id,
            status,
            type,
            is_consolidated
        ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    insert.run(1n, toBlob([1, 0, 0]), 'preset-a', 'active', 'fact', 1n)
    insert.run(2n, toBlob([0, 1, 0]), 'preset-a', 'active', 'fact', 0n)
    insert.run(3n, toBlob([1, 0, 0]), 'preset-b', 'active', 'fact', 1n)

    const nearest = database
        .prepare(
            `SELECT rowid, distance
             FROM smoke_vectors
             WHERE embedding MATCH ?
               AND k = ?
               AND preset_id = ?
               AND status = ?
               AND type = ?
               AND is_consolidated = ?
             ORDER BY distance ASC`
        )
        .all(toBlob([1, 0, 0]), 10, 'preset-a', 'active', 'fact', 1n)
    assert.deepEqual(nearest.map((row) => row.rowid), [1])
    assert.ok(nearest[0].distance < 0.000_001)

    database
        .prepare(
            `UPDATE smoke_vectors
             SET status = ?, is_consolidated = ?
             WHERE rowid = ?`
        )
        .run('archived', 0n, 1)
    const updated = database
        .prepare(
            `SELECT rowid
             FROM smoke_vectors
             WHERE embedding MATCH ?
               AND k = ?
               AND preset_id = ?
               AND status = ?
               AND is_consolidated = ?`
        )
        .all(toBlob([1, 0, 0]), 10, 'preset-a', 'archived', 0n)
    assert.deepEqual(updated.map((row) => row.rowid), [1])

    database.prepare('DELETE FROM smoke_vectors WHERE rowid = ?').run(1)
    assert.equal(
        database
            .prepare('SELECT COUNT(*) AS count FROM smoke_vectors')
            .get().count,
        2
    )
    const cjsEntry = resolve(projectRoot, 'lib', 'index.cjs')
    const esmEntry = resolve(projectRoot, 'lib', 'index.mjs')
    const require = createRequire(import.meta.url)
    require(cjsEntry)
    await import(pathToFileURL(esmEntry).href)

    const workerPaths = [cjsEntry, esmEntry].map((entry) =>
        resolve(dirname(entry), 'vector-index-worker.mjs')
    )
    assert.equal(workerPaths[0], workerPaths[1])

    for (let index = 0; index < workerPaths.length; index++) {
        const worker = new Worker(workerPaths[index])
        const exitPromise = new Promise((resolveExit) => {
            worker.once('exit', resolveExit)
        })
        const inspection = await waitForWorkerCall(worker, 1, {
            type: 'open',
            databasePath: resolve(
                temporaryDirectory,
                `worker-${index}.sqlite`
            )
        })
        assert.equal(inspection.sqliteVecVersion, version.version)
        await waitForWorkerCall(worker, 2, { type: 'dispose' })
        assert.equal(await exitPromise, 0)
    }

    console.log(`sqlite-vec ${version.version} native smoke passed`)
} finally {
    database.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
}
