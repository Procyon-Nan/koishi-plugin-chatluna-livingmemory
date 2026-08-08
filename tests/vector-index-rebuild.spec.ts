import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type {
    LegacyMemoryEmbeddingRecord,
    MemoryIndexSourceRecord,
    MemoryVectorIndexManifest
} from '../src/contracts/vector_index'
import { VectorIndexOperationGate } from '../src/service/vector_index/operation_gate'
import { rebuildVectorIndex } from '../src/service/vector_index/rebuild'
import { reconcileVectorIndexPreset } from '../src/service/vector_index/reconcile'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client'
import {
    ensureVectorIndexWorkerBuilt,
    vectorIndexWorkerPath
} from './vector-index-test-utils'

const workerPath = vectorIndexWorkerPath

before(async () => {
    await ensureVectorIndexWorkerBuilt()
})

const createSource = (
    id: string,
    options: Partial<MemoryIndexSourceRecord> = {}
): MemoryIndexSourceRecord => ({
    id,
    presetId: 'preset-a',
    status: 'active',
    type: 'fact',
    isConsolidated: false,
    content: `content ${id}`,
    keywords: [id],
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...options
})

class TestRebuildRepository {
    readonly legacy = new Map<string, LegacyMemoryEmbeddingRecord>()
    legacyPageCalls = 0

    constructor(readonly sources: MemoryIndexSourceRecord[]) {}

    async listEntryIndexSourcePage(afterId: string | null, limit: number) {
        return this.page(this.sources, afterId, limit)
    }

    async listEntryIndexSourcePageByPreset(
        presetId: string,
        afterId: string | null,
        limit: number
    ) {
        return this.page(
            this.sources.filter((source) => source.presetId === presetId),
            afterId,
            limit
        )
    }

    async listLegacyEmbeddingPage(afterId: string | null, limit: number) {
        this.legacyPageCalls++
        const records = this.sources.map((source) => {
            const legacy = this.legacy.get(source.id)
            if (legacy !== undefined) {
                return legacy
            }
            return {
                id: source.id,
                embedding: null,
                embeddingModelId: null
            }
        })
        return this.page(records, afterId, limit)
    }

    async listEntryPresetIds() {
        return [
            ...new Set(this.sources.map((source) => source.presetId))
        ].sort()
    }

    async countEntriesByPreset(presetId: string) {
        return this.sources.filter((source) => source.presetId === presetId)
            .length
    }

    async countEntries() {
        return this.sources.length
    }

    private page<T extends { id: string }>(
        records: T[],
        afterId: string | null,
        limit: number
    ) {
        return records
            .filter((record) => afterId === null || record.id > afterId)
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, limit)
    }
}

const createManifest = (
    generation: string,
    dimension = 3
): MemoryVectorIndexManifest => ({
    schemaVersion: 1,
    embeddingModelId: 'model-a',
    dimension,
    sqliteVecVersion: 'v0.1.9',
    generation,
    builtAt: Date.now()
})

const createVector = (text: string, dimension: number) => {
    const vector = new Array<number>(dimension).fill(0)
    vector[0] = 1
    if (dimension > 1) {
        vector[1] = (text.length % 11) / 10
    }
    return vector
}

const createEmbeddings = (
    dimension: number,
    calls: string[][],
    failure?: (texts: string[]) => Error | null
) => ({
    embedQuery: async (text: string) => createVector(text, dimension),
    embedDocuments: async (texts: string[]) => {
        calls.push([...texts])
        const error = failure?.(texts)
        if (error !== undefined && error !== null) {
            throw error
        }
        return texts.map((text) => createVector(text, dimension))
    }
})

const withWorker = async (
    callback: (
        client: LivingMemoryVectorIndexWorkerClient,
        directory: string
    ) => Promise<void>
) => {
    const directory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-rebuild-test-')
    )
    const client = new LivingMemoryVectorIndexWorkerClient(workerPath)
    try {
        await client.open(
            resolve(directory, 'vector-index.sqlite'),
            resolve(directory, 'vector-index.previous.sqlite')
        )
        await callback(client, directory)
    } finally {
        await client.dispose()
        await rm(directory, { recursive: true, force: true })
    }
}

const buildFormalIndex = async (options: {
    client: LivingMemoryVectorIndexWorkerClient
    directory: string
    repository: TestRebuildRepository
    embeddings: ReturnType<typeof createEmbeddings>
    generation: string
    reuseLegacyEmbeddings?: boolean
}) => {
    const {
        client,
        directory,
        repository,
        embeddings,
        generation,
        reuseLegacyEmbeddings = false
    } = options
    const manifest = createManifest(generation)
    return await rebuildVectorIndex({
        repository,
        worker: client,
        embeddings,
        embeddingModelId: manifest.embeddingModelId,
        dimension: manifest.dimension,
        reuseLegacyEmbeddings,
        manifest,
        rebuildDatabasePath: resolve(
            directory,
            `vector-index.rebuild-${generation}.sqlite`
        ),
        shouldStop: () => false,
        onProgress: async () => {},
        finalize: () =>
            client.finalizeRebuild(
                resolve(directory, 'vector-index.previous.sqlite'),
                repository.sources.length
            )
    })
}

it('reuses only valid legacy vectors during a full rebuild', async () => {
    await withWorker(async (client, directory) => {
        const repository = new TestRebuildRepository([
            createSource('memory-a'),
            createSource('memory-b'),
            createSource('memory-c'),
            createSource('memory-d'),
            createSource('memory-e')
        ])
        repository.legacy.set('memory-a', {
            id: 'memory-a',
            embedding: [1, 0, 0],
            embeddingModelId: 'model-a'
        })
        repository.legacy.set('memory-b', {
            id: 'memory-b',
            embedding: [0, 1, 0],
            embeddingModelId: 'other-model'
        })
        repository.legacy.set('memory-c', {
            id: 'memory-c',
            embedding: [1, 0],
            embeddingModelId: 'model-a'
        })
        repository.legacy.set('memory-d', {
            id: 'memory-d',
            embedding: [0, 0, 0],
            embeddingModelId: 'model-a'
        })
        repository.legacy.set('memory-e', {
            id: 'memory-e',
            embedding: [Number.POSITIVE_INFINITY, 0, 0],
            embeddingModelId: 'model-a'
        })
        const calls: string[][] = []

        await buildFormalIndex({
            client,
            directory,
            repository,
            embeddings: createEmbeddings(3, calls),
            generation: 'legacy',
            reuseLegacyEmbeddings: true
        })

        assert.deepEqual(calls, [
            [
                'content memory-b',
                'content memory-c',
                'content memory-d',
                'content memory-e'
            ]
        ])
        const vectors = await client.readVectors('preset-a', ['memory-a'])
        assert.deepEqual([...vectors.vectors[0].vector], [1, 0, 0])
    })
})

it('does not read legacy vectors after the migration is complete', async () => {
    await withWorker(async (client, directory) => {
        const repository = new TestRebuildRepository([
            createSource('memory-a')
        ])
        repository.legacy.set('memory-a', {
            id: 'memory-a',
            embedding: [0, 1, 0],
            embeddingModelId: 'model-a'
        })
        const calls: string[][] = []

        await buildFormalIndex({
            client,
            directory,
            repository,
            embeddings: createEmbeddings(3, calls),
            generation: 'without-legacy'
        })

        assert.equal(repository.legacyPageCalls, 0)
        assert.deepEqual(calls, [['content memory-a']])
    })
})

it('reconciles additions, metadata updates, content changes, and orphans', async () => {
    await withWorker(async (client, directory) => {
        const repository = new TestRebuildRepository([
            createSource('memory-a'),
            createSource('memory-b'),
            createSource('memory-orphan')
        ])
        await buildFormalIndex({
            client,
            directory,
            repository,
            embeddings: createEmbeddings(3, []),
            generation: 'reconcile'
        })
        const before = await client.readVectors('preset-a', ['memory-a'])

        repository.sources.splice(
            0,
            repository.sources.length,
            createSource('memory-a', {
                status: 'archived',
                type: 'preference',
                isConsolidated: true,
                keywords: ['updated'],
                updatedAt: new Date('2026-08-08T01:00:00.000Z')
            }),
            createSource('memory-b', {
                content: 'updated content memory-b'
            }),
            createSource('memory-new')
        )
        const calls: string[][] = []
        await reconcileVectorIndexPreset({
            presetId: 'preset-a',
            repository,
            worker: client,
            embeddings: createEmbeddings(3, calls),
            embeddingModelId: 'model-a',
            dimension: 3,
            shouldStop: () => false,
            onProgress: async () => {}
        })

        assert.deepEqual(calls, [
            ['updated content memory-b', 'content memory-new']
        ])
        const inventory = await client.readInventoryPage(
            'preset-a',
            null,
            10
        )
        assert.deepEqual(
            inventory.items.map((item) => item.memoryId),
            ['memory-a', 'memory-b', 'memory-new']
        )
        assert.equal(inventory.items[0].status, 'archived')
        assert.equal(inventory.items[0].type, 'preference')
        assert.equal(inventory.items[0].isConsolidated, true)
        assert.equal(
            inventory.items[0].updatedAt,
            +repository.sources[0].updatedAt
        )
        const after = await client.readVectors('preset-a', ['memory-a'])
        assert.deepEqual(
            [...after.vectors[0].vector],
            [...before.vectors[0].vector]
        )
        const inspection = await client.inspect()
        assert.equal(inspection.presets[0].state, 'ready')
        assert.equal(inspection.presets[0].indexedCount, 3)
    })
})

it('marks a preset dirty when reconcile embedding fails', async () => {
    await withWorker(async (client, directory) => {
        const repository = new TestRebuildRepository([
            createSource('memory-a')
        ])
        await buildFormalIndex({
            client,
            directory,
            repository,
            embeddings: createEmbeddings(3, []),
            generation: 'dirty'
        })
        repository.sources[0] = createSource('memory-a', {
            content: 'changed content'
        })

        await assert.rejects(
            reconcileVectorIndexPreset({
                presetId: 'preset-a',
                repository,
                worker: client,
                embeddings: createEmbeddings(
                    3,
                    [],
                    () => new Error('injected reconcile failure')
                ),
                embeddingModelId: 'model-a',
                dimension: 3,
                shouldStop: () => false,
                onProgress: async () => {}
            }),
            /vector index reconcile failed/u
        )
        const inspection = await client.inspect()
        assert.equal(inspection.presets[0].state, 'dirty')
        assert.match(
            inspection.presets[0].lastError ?? '',
            /injected reconcile failure/u
        )
    })
})

it('releases the exclusive operation barrier after a mutation fails', async () => {
    const gate = new VectorIndexOperationGate()
    await assert.rejects(
        gate.runMutation(async () => {
            throw new Error('injected mutation failure')
        }),
        /injected mutation failure/u
    )
    const result = await gate.runExclusive(async () => 'completed')
    assert.equal(result, 'completed')
})
