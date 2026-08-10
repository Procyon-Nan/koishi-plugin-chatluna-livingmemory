import assert from 'node:assert/strict'
import { access, cp, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type {
    MemoryEntryStatus,
    MemoryEntryType
} from '../src/contracts/memory'
import type { MemoryVectorIndexManifest } from '../src/contracts/vector_index'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client'
import type {
    VectorIndexDocument,
    VectorIndexReplaceUpsert
} from '../src/service/vector_index/worker_protocol'
import {
    ensureWorkersBuilt,
    vectorIndexWorkerPath
} from './worker-test-utils'

const workerPath = vectorIndexWorkerPath

let temporaryDirectory: string

before(async function () {
    this.timeout(30_000)
    await ensureWorkersBuilt()
    temporaryDirectory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-worker-test-')
    )
})

after(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
})

const createManifest = (): MemoryVectorIndexManifest => ({
    schemaVersion: 1,
    embeddingModelId: 'test-embedding-model',
    dimension: 3,
    storageEngine: 'pglite-pgvector',
    vectorExtensionVersion: '0.8.1',
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
        status?: MemoryEntryStatus
        types?: MemoryEntryType[] | null
        isConsolidated?: boolean | null
        limit?: number
    } = {}
) => ({
    presetId: options.presetId ?? 'preset-a',
    status: options.status ?? 'active',
    types: options.types ?? null,
    isConsolidated: options.isConsolidated ?? null,
    limit: options.limit ?? 30,
    vector: new Float32Array(vector)
})

it('runs typed vector index worker mutations and filtered searches', async () => {
    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    const formalPath = resolve(temporaryDirectory, 'vector-index')
    const rebuildPath = resolve(
        temporaryDirectory,
        'vector-index.rebuild-test'
    )
    const previousPath = resolve(
        temporaryDirectory,
        'vector-index.previous'
    )

    const initial = await client.open(formalPath, previousPath)
    assert.equal(initial.manifest, null)
    assert.equal(initial.indexedCount, 0)

    const manifest = createManifest()
    const created = await client.createRebuildFile(rebuildPath, manifest)
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
    const finalized = await client.finalizeRebuild(previousPath, 4)
    assert.equal(finalized.indexedCount, 4)

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
        query([1, 0, 0], { status: 'archived' })
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
    assert.deepEqual(vectors.missingMemoryIds, [
        'memory-c',
        'missing-memory'
    ])

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
})

it('rolls back a complete mutation batch when one upsert fails', async () => {
    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    const formalPath = resolve(temporaryDirectory, 'atomic')
    const rebuildPath = resolve(temporaryDirectory, 'atomic-rebuild')
    const previousPath = resolve(temporaryDirectory, 'atomic-previous')
    await client.open(formalPath, previousPath)
    await client.createRebuildFile(rebuildPath, createManifest())
    await client.appendRebuildBatch('preset-a', [
        replace(createDocument('stable-memory'), [1, 0, 0])
    ])
    await client.finalizeRebuild(previousPath, 1)

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
    const firstRebuildPath = resolve(
        temporaryDirectory,
        'abort-first-rebuild'
    )
    const secondRebuildPath = resolve(
        temporaryDirectory,
        'abort-second-rebuild'
    )
    const previousPath = resolve(temporaryDirectory, 'abort-previous')
    await client.open(formalPath, previousPath)
    await client.createRebuildFile(firstRebuildPath, createManifest())
    await client.appendRebuildBatch('preset-a', [
        replace(createDocument('retained-memory'), [1, 0, 0])
    ])
    await client.finalizeRebuild(previousPath, 1)

    await client.createRebuildFile(secondRebuildPath, {
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
    const rebuildPath = resolve(
        temporaryDirectory,
        'recovery-rebuild'
    )
    const previousPath = resolve(
        temporaryDirectory,
        'recovery-previous'
    )
    const first = new LivingMemoryVectorIndexWorkerClient(workerPath)
    await first.open(formalPath, previousPath)
    await first.createRebuildFile(rebuildPath, createManifest())
    await first.appendRebuildBatch('preset-a', [
        replace(createDocument('retained-memory'), [1, 0, 0])
    ])
    await first.finalizeRebuild(previousPath, 1)
    await first.dispose()

    await rename(formalPath, previousPath)
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
