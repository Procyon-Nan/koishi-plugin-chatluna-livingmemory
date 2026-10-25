import assert from 'node:assert/strict'
import {
    access,
    cp,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import type {
    MemoryEntryStatus,
    MemoryEntryType,
    MemorySearchStatus
} from '../src/contracts/memory'
import type { MemoryVectorIndexManifest } from '../src/contracts/vector_index'
import { LivingMemoryVectorIndexDatabase } from '../src/service/vector_index/worker/database'
import { startVectorIndexWorker } from '../src/service/vector_index/worker/runtime'
import { createVectorIndexSchema } from '../src/service/vector_index/worker/schema'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client'
import type {
    VectorIndexDocument,
    VectorIndexReplaceUpsert,
    VectorIndexWorkerRequest,
    VectorIndexWorkerResponse
} from '../src/service/vector_index/worker_protocol'
import { vectorIndexWorkerPath } from './worker-test-utils'

const workerPath = vectorIndexWorkerPath

let temporaryDirectory: string

beforeAll(async () => {
    temporaryDirectory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-worker-test-')
    )
}, 30_000)

afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
})

const createManifest = (): MemoryVectorIndexManifest => ({
    schemaVersion: 4,
    embeddingModelId: 'test-embedding-model',
    dimension: 3,
    storageEngine: 'pglite-pgvector',
    vectorExtensionVersion: '0.8.7',
    generation: 'test-generation',
    builtAt: Date.now()
})

const createDocument = (
    memoryId: string,
    options: {
        presetId?: string
        status?: MemoryEntryStatus
        type?: MemoryEntryType
        isConsolidated?: boolean
        keywords?: string[]
        contentHash?: string
    } = {}
): VectorIndexDocument => ({
    memoryId,
    presetId: options.presetId ?? 'preset-a',
    sourceConversationId: null,
    status: options.status ?? 'active',
    type: options.type ?? 'fact',
    isConsolidated: options.isConsolidated ?? true,
    contentHash: options.contentHash ?? `content-${memoryId}`,
    keywordsHash: `keywords-${memoryId}`,
    keywords: options.keywords ?? [],
    updatedAt: Date.now()
})

const replace = (
    document: VectorIndexDocument,
    values: number[]
): VectorIndexReplaceUpsert => ({
    vectorAction: 'replace',
    document,
    vector: new Float32Array(values)
})

const query = (
    vector: number[],
    options: {
        presetId?: string
        types?: MemoryEntryType[] | null
        isConsolidated?: boolean | null
        memoryStatus?: MemorySearchStatus
        limit?: number
    } = {}
) => ({
    presetId: options.presetId ?? 'preset-a',
    types: options.types ?? null,
    isConsolidated: options.isConsolidated ?? null,
    memoryStatus: options.memoryStatus ?? 'active',
    limit: options.limit ?? 30,
    vector: new Float32Array(vector)
})

class TestVectorIndexWorkerPort {
    readonly responses: VectorIndexWorkerResponse[] = []
    closed = false
    private listener: ((request: VectorIndexWorkerRequest) => void) | null =
        null

    on(
        _event: 'message',
        listener: (request: VectorIndexWorkerRequest) => void
    ) {
        this.listener = listener
    }

    postMessage(
        response: VectorIndexWorkerResponse,
        _transferList: ArrayBuffer[]
    ) {
        this.responses.push(response)
    }

    close() {
        this.closed = true
    }

    send(request: VectorIndexWorkerRequest) {
        assert.notEqual(this.listener, null)
        this.listener!(request)
    }
}

it('runs typed vector index worker mutations and filtered searches', async () => {
    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    const formalPath = resolve(temporaryDirectory, 'vector-index')
    const rebuildPath = resolve(temporaryDirectory, 'vector-index.rebuild-test')
    const previousPath = resolve(temporaryDirectory, 'vector-index.previous')

    const initial = await client.open(formalPath, previousPath)
    assert.equal(initial.vectorExtensionVersion, '0.8.7')
    assert.equal(initial.manifest, null)
    assert.equal(initial.indexedCount, 0)

    const manifest = createManifest()
    const created = await client.openRebuildDatabase(rebuildPath, manifest)
    assert.deepEqual(created.manifest, manifest)

    await client.appendRebuildBatch('preset-a', [
        replace(
            createDocument('memory-a', {
                keywords: ['Alpha', 'Shared']
            }),
            [1, 0, 0]
        ),
        replace(
            createDocument('memory-b', {
                type: 'preference',
                isConsolidated: false,
                keywords: ['Beta', 'Shared']
            }),
            [0, 1, 0]
        ),
        replace(
            createDocument('memory-c', {
                status: 'archived',
                keywords: ['Archive']
            }),
            [0.9, 0.1, 0]
        )
    ])
    await client.appendRebuildBatch('preset-b', [
        replace(
            createDocument('memory-d', {
                presetId: 'preset-b',
                keywords: ['Alpha']
            }),
            [1, 0, 0]
        )
    ])
    await client.markPresetState({
        presetId: 'preset-a',
        state: 'ready',
        expectedCount: 3,
        indexedCount: 3,
        lastError: null,
        updatedAt: Date.now()
    })
    const prepared = await client.validateAndCloseRebuildDatabase(4)
    assert.equal(prepared.indexedCount, 4)
    await rename(formalPath, previousPath)
    await rename(rebuildPath, formalPath)
    const finalized = await client.openCandidate(formalPath)
    await rm(previousPath, { recursive: true })
    assert.equal(finalized.indexedCount, 4)
    const neighborQuery = () => ({
        sourceIndex: 0,
        presetId: 'preset-a',
        generation: manifest.generation,
        sourceMemoryId: 'memory-a',
        vector: new Float32Array([1, 0, 0]),
        limit: 2,
        efSearch: 40
    })
    assert.equal(
        (await client.queryDreamNeighbors([neighborQuery()])).reason,
        'index-absent'
    )
    assert.deepEqual(await client.buildDreamAnnIndex(), { built: true })
    assert.deepEqual(await client.buildDreamAnnIndex(), { built: false })
    await assert.rejects(
        client.queryDreamNeighbors([
            { ...neighborQuery(), generation: 'stale' }
        ]),
        /generation changed/u
    )

    const factHits = await client.queryKnn(
        query([1, 0, 0], {
            types: ['fact'],
            isConsolidated: true
        })
    )
    assert.deepEqual(
        factHits.map((hit) => hit.memoryId),
        ['memory-a']
    )
    const presetBHits = await client.queryKnn(
        query([1, 0, 0], { presetId: 'preset-b' })
    )
    assert.deepEqual(
        presetBHits.map((hit) => hit.memoryId),
        ['memory-d']
    )

    const hybridHits = await client.queryHybrid({
        ...query([1, 0, 0]),
        keywords: ['beta'],
        minSimilarity: 0.8
    })
    assert.deepEqual(
        hybridHits.map((hit) => ({
            memoryId: hit.memoryId,
            keywordMatchCount: hit.keywordMatchCount,
            boostedScore: hit.boostedScore
        })),
        [
            {
                memoryId: 'memory-a',
                keywordMatchCount: 0,
                boostedScore: 1
            },
            {
                memoryId: 'memory-b',
                keywordMatchCount: 1,
                boostedScore: 0.3
            }
        ]
    )

    const archivedHits = await client.queryKnn(
        query([1, 0, 0], { memoryStatus: 'archived' })
    )
    assert.deepEqual(
        archivedHits.map((hit) => hit.memoryId),
        ['memory-c']
    )
    const allHits = await client.queryKnn(
        query([1, 0, 0], { memoryStatus: 'all' })
    )
    assert.deepEqual(
        allHits.map((hit) => hit.memoryId),
        ['memory-a', 'memory-c', 'memory-b']
    )

    const archivedA = createDocument('memory-a', {
        status: 'archived',
        keywords: ['Alpha', 'Shared']
    })
    await client.applyMutation({
        presetId: 'preset-a',
        upserts: [
            {
                vectorAction: 'preserve',
                document: archivedA
            }
        ],
        deletes: []
    })
    const activeAfterArchive = await client.queryKnn(query([1, 0, 0]))
    assert.deepEqual(
        activeAfterArchive.map((hit) => hit.memoryId),
        ['memory-b']
    )
    const archivedAfterArchive = await client.queryKnn(
        query([1, 0, 0], { memoryStatus: 'archived' })
    )
    assert.deepEqual(
        archivedAfterArchive.map((hit) => hit.memoryId),
        ['memory-a', 'memory-c']
    )
    await client.applyMutation({
        presetId: 'preset-a',
        upserts: [
            replace(
                createDocument('memory-b', {
                    type: 'preference',
                    keywords: ['Gamma'],
                    contentHash: 'content-memory-b-updated'
                }),
                [1, 0, 0]
            )
        ],
        deletes: ['memory-c']
    })
    const vectors = await client.readVectors('preset-a', [
        'memory-b',
        'memory-b',
        'memory-c',
        'missing-memory'
    ])
    assert.deepEqual(
        vectors.vectors.map(({ memoryId, vector }) => ({
            memoryId,
            vector: [...vector]
        })),
        [
            { memoryId: 'memory-b', vector: [1, 0, 0] },
            { memoryId: 'memory-b', vector: [1, 0, 0] }
        ]
    )
    assert.deepEqual(vectors.missingMemoryIds, ['memory-c', 'missing-memory'])

    const dreamPage = await client.readDreamVectors('preset-a', [
        'memory-b',
        'memory-c'
    ])
    assert.equal(dreamPage.dimension, 3)
    assert.equal(typeof dreamPage.generation, 'string')
    assert.equal(dreamPage.items[0].memoryId, 'memory-b')
    assert.equal(dreamPage.items[0].contentHash, 'content-memory-b-updated')
    assert.equal(dreamPage.items[0].status, 'active')
    assert.ok(dreamPage.items[0].vector instanceof Float32Array)
    assert.deepEqual([...dreamPage.items[0].vector], [1, 0, 0])
    assert.deepEqual(dreamPage.missingMemoryIds, ['memory-c'])

    const inventory = await client.readInventoryPage(null, null, 2)
    assert.deepEqual(
        inventory.items.map((item) => item.memoryId),
        ['memory-a', 'memory-b']
    )
    assert.equal(inventory.nextCursor, 'memory-b')

    const cleared = await client.clearPreset('preset-b')
    assert.equal(cleared.deletedCount, 1)
    const inspection = await client.inspect()
    assert.equal(inspection.indexedCount, 2)

    await client.dispose()

    const finalizedDatabase = await PGlite.create(formalPath, {
        extensions: { vector }
    })
    try {
        await finalizedDatabase.exec('CREATE EXTENSION IF NOT EXISTS vector')
        const indexes = await finalizedDatabase.query<{
            indexName: string
            indexDefinition: string
        }>(
            `SELECT
                indexname AS "indexName",
                indexdef AS "indexDefinition"
             FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename = 'lm_index_memory'
             ORDER BY indexname ASC`
        )
        const consolidatedIndex = indexes.rows.find(
            (row) => row.indexName === 'lm_index_memory_consolidated_filter'
        )
        assert.notEqual(consolidatedIndex, undefined)
        assert.match(
            consolidatedIndex!.indexDefinition,
            /\(preset_id, status\) WHERE \(is_consolidated = true\)$/u
        )
    } finally {
        await finalizedDatabase.close()
    }
})

it('rolls back a complete mutation batch when one upsert fails', async () => {
    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    const formalPath = resolve(temporaryDirectory, 'atomic')
    const rebuildPath = resolve(temporaryDirectory, 'atomic-rebuild')
    const previousPath = resolve(temporaryDirectory, 'atomic-previous')
    await client.open(formalPath, previousPath)
    await client.openRebuildDatabase(rebuildPath, createManifest())
    await client.appendRebuildBatch('preset-a', [
        replace(createDocument('stable-memory'), [1, 0, 0])
    ])
    await client.validateAndCloseRebuildDatabase(1)
    await rename(formalPath, previousPath)
    await rename(rebuildPath, formalPath)
    await client.openCandidate(formalPath)
    await rm(previousPath, { recursive: true })

    await assert.rejects(
        client.applyMutation({
            presetId: 'preset-a',
            upserts: [
                replace(
                    createDocument('stable-memory', {
                        contentHash: 'changed-content'
                    }),
                    [0, 1, 0]
                ),
                {
                    vectorAction: 'preserve',
                    document: createDocument('missing-memory')
                }
            ],
            deletes: []
        }),
        /cannot preserve missing vector/
    )

    const vectors = await client.readVectors('preset-a', ['stable-memory'])
    assert.deepEqual([...vectors.vectors[0].vector], [1, 0, 0])
    const inventory = await client.readInventoryPage('preset-a', null, 10)
    assert.equal(inventory.items[0].contentHash, 'content-stable-memory')
    await client.dispose()
})

it('restores the formal index when a rebuild is aborted', async () => {
    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    const formalPath = resolve(temporaryDirectory, 'abort')
    const firstRebuildPath = resolve(temporaryDirectory, 'abort-first-rebuild')
    const secondRebuildPath = resolve(
        temporaryDirectory,
        'abort-second-rebuild'
    )
    const previousPath = resolve(temporaryDirectory, 'abort-previous')
    await client.open(formalPath, previousPath)
    await client.openRebuildDatabase(firstRebuildPath, createManifest())
    await client.appendRebuildBatch('preset-a', [
        replace(createDocument('retained-memory'), [1, 0, 0])
    ])
    await client.validateAndCloseRebuildDatabase(1)
    await rename(formalPath, previousPath)
    await rename(firstRebuildPath, formalPath)
    await client.openCandidate(formalPath)
    await rm(previousPath, { recursive: true })

    await client.openRebuildDatabase(secondRebuildPath, {
        ...createManifest(),
        generation: 'aborted-generation'
    })
    const restored = await client.abortRebuild()
    assert.equal(restored.manifest?.generation, 'test-generation')
    assert.equal(restored.indexedCount, 1)
    await client.dispose()
})

it('recovers files left by an interrupted rebuild switch', async () => {
    const formalPath = resolve(temporaryDirectory, 'recovery')
    const rebuildPath = resolve(temporaryDirectory, 'recovery-rebuild')
    const previousPath = resolve(temporaryDirectory, 'recovery-previous')
    const first = new LivingMemoryVectorIndexWorkerClient(workerPath)
    await first.open(formalPath, previousPath)
    await first.openRebuildDatabase(rebuildPath, createManifest())
    await first.appendRebuildBatch('preset-a', [
        replace(createDocument('retained-memory'), [1, 0, 0])
    ])
    await first.validateAndCloseRebuildDatabase(1)
    await first.dispose()

    await rename(rebuildPath, previousPath)
    const recovered = new LivingMemoryVectorIndexWorkerClient(workerPath)
    const inspection = await recovered.open(formalPath, previousPath)
    assert.equal(inspection.manifest?.generation, 'test-generation')
    assert.equal(inspection.indexedCount, 1)
    await recovered.dispose()

    await cp(formalPath, previousPath, { recursive: true })
    const cleaned = new LivingMemoryVectorIndexWorkerClient(workerPath)
    await cleaned.open(formalPath, previousPath)
    await assert.rejects(access(previousPath), { code: 'ENOENT' })
    await cleaned.dispose()
})

it('quarantines an unreadable recovered index before rebuilding', async () => {
    const formalPath = resolve(temporaryDirectory, 'quarantine-recovery')
    const previousPath = resolve(
        temporaryDirectory,
        'quarantine-recovery-previous'
    )
    const originalContent = 'unreadable recovered index'
    await writeFile(previousPath, originalContent)

    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    const inspection = await client.open(formalPath, previousPath)
    assert.equal(inspection.manifest, null)
    await client.dispose()

    const quarantineName = (await readdir(temporaryDirectory)).find((name) =>
        name.startsWith('quarantine-recovery.failed-')
    )
    assert.notEqual(quarantineName, undefined)
    assert.equal(
        await readFile(resolve(temporaryDirectory, quarantineName!), 'utf8'),
        originalContent
    )
})

it('analyzes the rebuild database before switching it into place', async () => {
    const formalPath = resolve(temporaryDirectory, 'analyze-order')
    const rebuildPath = resolve(temporaryDirectory, 'analyze-order-rebuild')
    const previousPath = resolve(temporaryDirectory, 'analyze-order-previous')
    let analyzed = false
    const database = new LivingMemoryVectorIndexDatabase({
        analyze: async (connection) => {
            assert.equal(analyzed, false)
            const count = await connection.query<{ count: string }>(
                `SELECT COUNT(*)::text AS count FROM lm_index_memory`
            )
            assert.equal(count.rows[0].count, '1')
            analyzed = true
        }
    })

    await database.open(formalPath, previousPath)
    await database.openRebuildDatabase(rebuildPath, createManifest())
    await database.appendRebuildBatch('preset-a', [
        replace(createDocument('analyzed-before-switch'), [1, 0, 0])
    ])
    const prepared = await database.validateAndCloseRebuildDatabase(1)
    await rename(formalPath, previousPath)
    await rename(rebuildPath, formalPath)
    const inspection = await database.openCandidate(formalPath)
    await rm(previousPath, { recursive: true })

    assert.equal(analyzed, true)
    assert.equal(prepared.indexedCount, 1)
    assert.equal(inspection.indexedCount, 1)
    await database.dispose()
})

it('closes the worker port when database disposal fails', async () => {
    const disposeError = new Error('injected database disposal failure')
    const database = new LivingMemoryVectorIndexDatabase()
    database.dispose = async () => {
        throw disposeError
    }
    const port = new TestVectorIndexWorkerPort()
    const runtime = startVectorIndexWorker(port, database)

    port.send({ id: 1, command: { type: 'dispose' } })
    await runtime.waitForIdle()

    assert.equal(port.closed, true)
    assert.equal(port.responses.length, 1)
    const response = port.responses[0]
    assert.equal(response.ok, false)
    if (response.ok) {
        assert.fail('dispose failure returned a successful worker response')
    }
    assert.equal(response.error.message, disposeError.message)
})

it.each([false, true])(
    'preserves the database and cold backup during extension migration (fail=%s)',
    async (fail) => {
        const name = `extension-migration-${fail}`
        const formalPath = resolve(temporaryDirectory, name)
        const manifest = {
            ...createManifest(),
            vectorExtensionVersion: '0.8.1'
        }
        const seed = await PGlite.create(formalPath, { extensions: { vector } })
        try {
            await seed.exec('CREATE EXTENSION vector')
            await createVectorIndexSchema(seed, manifest)
            // 模拟旧版本元数据以覆盖升级事务；旧二进制目录兼容性纳入发布验收。
            await seed.exec(`
            UPDATE pg_extension SET extversion = '0.8.1' WHERE extname = 'vector';
            INSERT INTO lm_index_memory VALUES (
                'retained', 'preset-a', NULL, 'active', 'fact', true,
                'content-retained', 'keywords', 0, '[1,2,3]'
            );
        `)
            if (fail) {
                await seed.exec(`ALTER TABLE lm_index_manifest ADD CONSTRAINT fail_upgrade
                CHECK (vector_extension_version = '0.8.1')`)
            }
        } finally {
            await seed.close()
        }
        const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
        try {
            const opening = client.open(formalPath, `${formalPath}.previous`)
            if (fail) {
                await assert.rejects(opening, {
                    code: 'extension-migration-failed'
                })
            } else {
                const inspection = await opening
                assert.equal(inspection.vectorExtensionVersion, '0.8.7')
                assert.deepEqual(inspection.manifest, {
                    ...manifest,
                    vectorExtensionVersion: '0.8.7'
                })
                const vectors = await client.readDreamVectors('preset-a', [
                    'retained'
                ])
                assert.deepEqual([...vectors.items[0].vector], [1, 2, 3])
                assert.equal(vectors.items[0].contentHash, 'content-retained')
            }
        } finally {
            await client.dispose()
        }
        const directories = await readdir(temporaryDirectory)
        assert.equal(
            directories.some((item) => item.startsWith(`${name}.failed-`)),
            false
        )
        const backup = directories.find((item) =>
            item.startsWith(`${name}.vector-0.8.1-backup-`)
        )!
        assert.ok(backup)
        for (const path of [formalPath, resolve(temporaryDirectory, backup)]) {
            const stored = await PGlite.create(path, { extensions: { vector } })
            try {
                const expectedVersion =
                    fail || path !== formalPath ? '0.8.1' : '0.8.7'
                const extension = await stored.query<{ extversion: string }>(
                    "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
                )
                assert.equal(extension.rows[0].extversion, expectedVersion)
                const row = await stored.query<{
                    generation: string
                    version: string
                }>(
                    'SELECT generation, vector_extension_version AS version FROM lm_index_manifest'
                )
                assert.deepEqual(row.rows[0], {
                    generation: manifest.generation,
                    version: expectedVersion
                })
                const vectorRow = await stored.query<{ embedding: string }>(
                    'SELECT embedding::text AS embedding FROM lm_index_memory'
                )
                assert.equal(vectorRow.rows[0].embedding, '[1,2,3]')
            } finally {
                await stored.close()
            }
        }
    },
    60_000
)

it('rejects pending requests when the worker cannot start', async () => {
    const client = new LivingMemoryVectorIndexWorkerClient(
        resolve(temporaryDirectory, 'missing-worker.mjs')
    )
    await assert.rejects(
        client.open(
            resolve(temporaryDirectory, 'never-opened'),
            resolve(temporaryDirectory, 'never-opened.previous')
        ),
        /Cannot find module|cannot find module/
    )
})
