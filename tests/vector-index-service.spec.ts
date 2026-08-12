import assert from 'node:assert/strict'
import {
    access,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    utimes,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Context, Logger } from 'koishi'
import type {
    MemoryJobKind,
    MemoryJobRecord,
    MemoryRecallStrategy,
    MemoryScope
} from '../src/contracts/memory'
import type {
    LegacyMemoryEmbeddingRecord,
    MemoryIndexSourceRecord
} from '../src/contracts/vector_index'
import { LivingMemoryVectorIndexOwnershipLock } from '../src/service/vector_index/ownership_lock'
import {
    LivingMemoryVectorIndexService,
    type VectorIndexWorkerFactory
} from '../src/service/vector_index/service'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client'
import { ensureWorkersBuilt, vectorIndexWorkerPath } from './worker-test-utils'

const workerPath = vectorIndexWorkerPath

beforeEach(function () {
    this.timeout(30_000)
})

afterEach(function () {
    this.timeout(30_000)
})

before(async () => {
    await ensureWorkersBuilt()
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

class TestVectorIndexRepository {
    readonly jobs: MemoryJobRecord[] = []
    readonly legacy = new Map<string, LegacyMemoryEmbeddingRecord>()
    readonly sources: MemoryIndexSourceRecord[]
    legacyEmbeddingsMigrated = false
    legacyPageCalls = 0

    constructor(sources: MemoryIndexSourceRecord[]) {
        this.sources = sources
    }

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
        const rows = this.sources.map((source) => {
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
        return this.page(rows, afterId, limit)
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

    async hasMigratedLegacyEmbeddings() {
        return this.legacyEmbeddingsMigrated
    }

    async completeLegacyEmbeddingMigration() {
        this.legacyEmbeddingsMigrated = true
        this.legacy.clear()
    }

    async createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        recallStrategy: MemoryRecallStrategy | null = null
    ) {
        const now = new Date()
        const job: MemoryJobRecord = {
            id: `job-${this.jobs.length + 1}`,
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            recallStrategy,
            status: 'pending',
            input,
            detail: null,
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        }
        this.jobs.push(job)
        return job
    }

    async updateJob(id: string, patch: Partial<MemoryJobRecord>) {
        const job = this.jobs.find((item) => item.id === id)
        assert.ok(job)
        Object.assign(job, patch)
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

const createVector = (text: string, dimension: number) => {
    const vector = new Array<number>(dimension).fill(0)
    vector[0] = 1
    if (dimension > 1) {
        vector[1] = (text.length % 7) / 10
    }
    return vector
}

const createEmbeddings = (
    dimension: number,
    calls: string[][],
    onDocuments?: (texts: string[]) => Promise<void>
) => ({
    embedQuery: async (text: string) => createVector(text, dimension),
    embedDocuments: async (texts: string[]) => {
        calls.push([...texts])
        if (onDocuments !== undefined) {
            await onDocuments(texts)
        }
        return texts.map((text) => createVector(text, dimension))
    }
})

const createLogger = () => {
    const info: string[] = []
    const warnings: unknown[][] = []
    const logger = {
        info: (message: unknown) => info.push(String(message)),
        warn: (...args: unknown[]) => warnings.push(args)
    } as unknown as Logger
    return { logger, info, warnings }
}

const createService = (options: {
    baseDir: string
    repository: TestVectorIndexRepository
    modelId: string
    dimension: number
    debug?: boolean
    logger?: Logger
    calls?: string[][]
    schemaVersion?: number
    workerPath?: string
    workerFactory?: VectorIndexWorkerFactory
    onDocuments?: (texts: string[]) => Promise<void>
}) => {
    const calls = options.calls ?? []
    const embeddings = createEmbeddings(
        options.dimension,
        calls,
        options.onDocuments
    )
    const ctx = {
        baseDir: options.baseDir,
        chatluna: {
            createEmbeddings: async (modelId: string) => {
                assert.equal(modelId, options.modelId)
                return { value: embeddings }
            }
        }
    } as unknown as Context
    const logger = options.logger ?? createLogger().logger
    return new LivingMemoryVectorIndexService(
        ctx,
        {
            embeddingModel: options.modelId,
            debug: options.debug ?? false
        },
        options.repository,
        logger,
        {
            schemaVersion: options.schemaVersion,
            workerFactory:
                options.workerFactory ??
                ((onFailure) =>
                    new LivingMemoryVectorIndexWorkerClient(
                        options.workerPath ?? workerPath,
                        onFailure
                    ))
        }
    )
}

const withTemporaryDirectory = async (
    callback: (directory: string) => Promise<void>
) => {
    const directory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-service-test-')
    )
    try {
        await callback(directory)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

const resolveIndexDirectory = (baseDir: string) =>
    resolve(baseDir, 'data', 'chatluna', 'living-memory')

it('builds the index once and reuses its manifest after restart', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a'),
            createSource('memory-b', {
                type: 'preference',
                isConsolidated: true
            })
        ])
        const firstCalls: string[][] = []
        const first = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3,
            calls: firstCalls
        })
        assert.throws(
            () => first.assertPresetReady('preset-a'),
            /vector index is not ready/u
        )
        await first.start()
        await first.waitForInitialization()
        const firstStatus = first.getStatus()
        assert.equal(firstStatus.state, 'ready')
        assert.equal(firstStatus.presets[0].indexedCount, 2)
        assert.doesNotThrow(() => first.assertPresetReady('preset-a'))
        assert.equal(repository.jobs[0].status, 'completed')
        assert.equal(
            repository.jobs[0].detail,
            'vector index rebuild completed: jobId=job-1 presetId=* indexed=2'
        )
        assert.equal(repository.legacyEmbeddingsMigrated, true)
        assert.ok(
            firstCalls.some((texts) => texts.includes('content memory-a'))
        )
        const semanticHits = await first.searchSemantic({
            presetId: 'preset-a',
            searchTexts: ['content memory-a'],
            status: 'active',
            memoryTypes: ['fact'],
            maxCandidates: 2
        })
        assert.deepEqual(
            semanticHits.map((hit) => hit.memoryId),
            ['memory-a']
        )
        const hybridHits = await first.searchHybrid({
            presetId: 'preset-a',
            searchTexts: ['content memory-a'],
            keywords: ['memory-b'],
            status: 'active',
            memoryTypes: null,
            maxCandidates: 2,
            minSimilarity: 0
        })
        assert.equal(hybridHits[0].memoryId, 'memory-b')
        assert.equal(hybridHits[0].keywordMatchCount, 1)
        const neighbors = await first.findConsolidatedNeighbors({
            presetId: 'preset-a',
            seedMemoryId: 'memory-a',
            status: 'active',
            excludedMemoryIds: [],
            limit: 30
        })
        assert.deepEqual(neighbors, ['memory-b'])
        const vectors = await first.readVectors('preset-a', ['memory-a'])
        assert.deepEqual([...vectors.keys()], ['memory-a'])
        assert.ok(vectors.get('memory-a') instanceof Float32Array)
        await assert.rejects(
            first.readVectors('preset-a', ['missing-memory']),
            /vector index entries are missing/u
        )
        await first.stop()

        const secondCalls: string[][] = []
        const second = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3,
            calls: secondCalls
        })
        await second.start()
        await second.waitForInitialization()
        const secondStatus = second.getStatus()
        assert.equal(secondStatus.state, 'ready')
        assert.equal(
            secondStatus.manifest?.generation,
            firstStatus.manifest?.generation
        )
        assert.equal(repository.jobs[1].status, 'completed')
        assert.equal(
            repository.jobs[1].detail,
            'vector index reconcile completed: jobId=job-2 presetId=* indexed=2'
        )
        assert.equal(secondCalls.length, 1)
        await second.stop()
    })
})

it('removes legacy SQLite index files after initialization succeeds', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const indexDirectory = resolveIndexDirectory(baseDir)
        await mkdir(indexDirectory, { recursive: true })
        const legacyFiles = [
            'vector-index.sqlite',
            'vector-index.previous.sqlite',
            'vector-index.rebuild-job-1.sqlite'
        ].map((filename) => resolve(indexDirectory, filename))
        for (const file of legacyFiles) {
            await writeFile(file, 'legacy index')
        }
        const unrelatedFile = resolve(indexDirectory, 'unrelated.sqlite')
        await writeFile(unrelatedFile, 'unrelated data')

        const service = createService({
            baseDir,
            repository: new TestVectorIndexRepository([
                createSource('memory-a')
            ]),
            modelId: 'model-a',
            dimension: 3
        })
        await service.start()
        await service.waitForInitialization()

        assert.equal(service.getStatus().state, 'ready')
        for (const file of legacyFiles) {
            await assert.rejects(access(file), { code: 'ENOENT' })
        }
        await access(unrelatedFile)
        await service.stop()
    })
})

it('keeps legacy SQLite index files when initialization fails', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const indexDirectory = resolveIndexDirectory(baseDir)
        const legacyFile = resolve(indexDirectory, 'vector-index.sqlite')
        await mkdir(indexDirectory, { recursive: true })
        await writeFile(legacyFile, 'legacy index')

        const service = createService({
            baseDir,
            repository: new TestVectorIndexRepository([
                createSource('memory-a')
            ]),
            modelId: 'model-a',
            dimension: 3,
            onDocuments: async (texts) => {
                if (!texts[0].includes('dimension probe')) {
                    throw new Error('injected embedding failure')
                }
            }
        })
        await service.start()
        await service.waitForInitialization()

        assert.equal(service.getStatus().state, 'unavailable')
        await access(legacyFile)
        await service.stop()
    })
})

it('warns without failing initialization when legacy cleanup fails', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const legacyDirectory = resolve(
            resolveIndexDirectory(baseDir),
            'vector-index.sqlite'
        )
        await mkdir(legacyDirectory, { recursive: true })
        const captured = createLogger()
        const service = createService({
            baseDir,
            repository: new TestVectorIndexRepository([
                createSource('memory-a')
            ]),
            modelId: 'model-a',
            dimension: 3,
            logger: captured.logger
        })
        await service.start()
        await service.waitForInitialization()

        assert.equal(service.getStatus().state, 'ready')
        assert.equal(captured.warnings.length, 1)
        assert.equal(
            captured.warnings[0][0],
            'memory background operation failed: workflow=vector-index operation=legacy-index-cleanup'
        )
        await access(legacyDirectory)
        await service.stop()
    })
})

it('restarts the worker and reinitializes the existing index', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await service.start()
        await service.waitForInitialization()

        await service.restart()
        assert.equal(service.getStatus().state, 'building')
        await service.waitForInitialization()

        assert.equal(service.getStatus().state, 'ready')
        assert.equal(repository.jobs.length, 2)
        await service.stop()
    })
})

it('starts a full rebuild without blocking the caller', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await service.start()
        await service.waitForInitialization()
        const legacyPageCalls = repository.legacyPageCalls

        service.startRebuild('manual rebuild')
        assert.equal(service.getStatus().state, 'building')
        await service.waitForMaintenance()

        assert.equal(service.getStatus().state, 'ready')
        assert.equal(repository.legacyPageCalls, legacyPageCalls)
        assert.match(repository.jobs.at(-1)?.input ?? '', /manual rebuild/u)
        await service.stop()
    })
})

it('rolls back to the previous index when the candidate worker cannot open', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const initial = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await initial.start()
        await initial.waitForInitialization()
        const initialGeneration = initial.getStatus().manifest?.generation
        await initial.stop()

        const candidateError = new Error('injected candidate open failure')
        let created = 0
        const failed = createService({
            baseDir,
            repository,
            modelId: 'model-b',
            dimension: 3,
            workerFactory: (onFailure) => {
                created += 1
                const worker = new LivingMemoryVectorIndexWorkerClient(
                    workerPath,
                    onFailure
                )
                if (created === 2) {
                    const openCandidate = worker.openCandidate.bind(worker)
                    worker.openCandidate = async (directory) => {
                        await openCandidate(directory)
                        throw candidateError
                    }
                }
                return worker
            }
        })
        await failed.start()
        await failed.waitForInitialization()
        assert.equal(failed.getStatus().state, 'unavailable')
        assert.match(
            failed.getStatus().lastError ?? '',
            /injected candidate open failure/u
        )
        await failed.stop()

        const indexFiles = await readdir(resolveIndexDirectory(baseDir))
        assert.equal(
            indexFiles.some((file) => file.startsWith('vector-index.rebuild-')),
            false
        )
        assert.equal(
            indexFiles.includes('vector-index.previous.pglite'),
            false
        )

        const recovered = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3
        })
        await recovered.start()
        await recovered.waitForInitialization()
        assert.equal(recovered.getStatus().state, 'ready')
        assert.equal(
            recovered.getStatus().manifest?.generation,
            initialGeneration
        )
        await recovered.stop()
    })
})

it('rebuilds when the model, dimension, or schema version changes', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const configurations = [
            { modelId: 'model-a', dimension: 3, schemaVersion: 1 },
            { modelId: 'model-b', dimension: 3, schemaVersion: 1 },
            { modelId: 'model-b', dimension: 4, schemaVersion: 1 },
            { modelId: 'model-b', dimension: 4, schemaVersion: 2 },
            { modelId: 'model-b', dimension: 4, schemaVersion: 3 }
        ]
        const generations: string[] = []

        for (const configuration of configurations) {
            const service = createService({
                baseDir,
                repository,
                ...configuration
            })
            await service.start()
            await service.waitForInitialization()
            const status = service.getStatus()
            assert.equal(status.state, 'ready')
            assert.equal(
                status.manifest?.embeddingModelId,
                configuration.modelId
            )
            assert.equal(status.manifest?.dimension, configuration.dimension)
            assert.equal(
                status.manifest?.schemaVersion,
                configuration.schemaVersion
            )
            generations.push(status.manifest?.generation ?? '')
            await service.stop()
        }

        assert.equal(new Set(generations).size, configurations.length)
    })
})

it('replaces a corrupt formal database through the rebuild path', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const indexDirectory = resolve(
            baseDir,
            'data',
            'chatluna',
            'living-memory'
        )
        await mkdir(indexDirectory, { recursive: true })
        await writeFile(
            resolve(indexDirectory, 'vector-index.pglite'),
            'not a PGlite data directory'
        )
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3
        })

        await service.start()
        await service.waitForInitialization()
        const status = service.getStatus()
        assert.equal(status.state, 'ready')
        assert.equal(status.presets[0].indexedCount, 1)
        assert.match(repository.jobs[0].input, /index manifest is missing/u)
        await service.stop()
    })
})

it('reports worker startup failure as unavailable', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([])
        const captured = createLogger()
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3,
            workerPath: resolve(baseDir, 'missing-worker.mjs'),
            logger: captured.logger
        })

        await service.start()
        await service.waitForInitialization()
        const status = service.getStatus()
        assert.equal(status.state, 'unavailable')
        assert.match(status.lastError ?? '', /worker/u)
        assert.equal(captured.warnings.length, 1)
        await service.stop()
    })
})

it('keeps index jobs running until work completes and records failures', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        let releaseDocuments = () => {}
        const documentsReleased = new Promise<void>((resolvePromise) => {
            releaseDocuments = resolvePromise
        })
        let signalDocumentsStarted = () => {}
        const documentsStarted = new Promise<void>((resolvePromise) => {
            signalDocumentsStarted = resolvePromise
        })
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3,
            onDocuments: async (texts) => {
                if (texts[0].includes('dimension probe')) {
                    return
                }
                signalDocumentsStarted()
                await documentsReleased
            }
        })

        await service.start()
        await documentsStarted
        assert.equal(repository.jobs[0].status, 'running')
        releaseDocuments()
        await service.waitForInitialization()
        assert.equal(repository.jobs[0].status, 'completed')
        await service.stop()
    })

    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([
            createSource('memory-a')
        ])
        const captured = createLogger()
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3,
            logger: captured.logger,
            onDocuments: async (texts) => {
                if (!texts[0].includes('dimension probe')) {
                    throw new Error('injected embedding failure')
                }
            }
        })

        await service.start()
        await service.waitForInitialization()
        assert.equal(repository.jobs[0].status, 'failed')
        assert.match(repository.jobs[0].error ?? '', /embedding failure/u)
        assert.equal(service.getStatus().state, 'unavailable')
        assert.equal(repository.legacyEmbeddingsMigrated, false)
        assert.equal(captured.warnings.length, 1)
        await service.stop()
    })
})

it('logs rebuild batch progress only when debug is enabled', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository(
            Array.from({ length: 51 }, (_, index) =>
                createSource(`memory-${String(index).padStart(2, '0')}`)
            )
        )
        const captured = createLogger()
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3,
            debug: true,
            logger: captured.logger
        })

        await service.start()
        await service.waitForInitialization()
        assert.ok(
            captured.info.some((message) =>
                /vector index rebuild progress: jobId=job-1 presetId=\* completed=50 total=51 batchElapsedMs=\d+\.\d elapsedMs=\d+\.\d/u.test(
                    message
                )
            )
        )
        assert.ok(
            captured.info.some((message) =>
                /vector index rebuild progress: jobId=job-1 presetId=\* completed=51 total=51 batchElapsedMs=\d+\.\d elapsedMs=\d+\.\d/u.test(
                    message
                )
            )
        )
        assert.ok(
            captured.info.some((message) =>
                /vector index reconcile progress: jobId=job-1 presetId=preset-a completed=51 total=51/u.test(
                    message
                )
            )
        )
        await service.stop()
    })
})

it('restores the active worker when rebuild worker shutdown reports failure', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const repository = new TestVectorIndexRepository([])
        const captured = createLogger()
        const disposeError = new Error('injected worker disposal failure')
        let created = 0
        const service = createService({
            baseDir,
            repository,
            modelId: 'model-a',
            dimension: 3,
            logger: captured.logger,
            workerFactory: (onFailure) => {
                created += 1
                const worker = new LivingMemoryVectorIndexWorkerClient(
                    workerPath,
                    onFailure
                )
                const dispose = worker.dispose.bind(worker)
                worker.dispose = async () => {
                    await dispose()
                    if (created === 1) {
                        throw disposeError
                    }
                }
                return worker
            }
        })

        await service.start()
        await service.waitForInitialization()
        assert.equal(captured.warnings.length, 1)
        assert.match(
            String(captured.warnings[0][0]),
            /vector index rebuild failed: Error: injected worker disposal failure/u
        )
        await service.stop()
        assert.equal(captured.warnings.length, 1)
    })
})

it('rejects a second owner and takes over a stale lock', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const lockPath = resolve(baseDir, 'vector-index.lock')
        const first = new LivingMemoryVectorIndexOwnershipLock(
            lockPath,
            () => {}
        )
        const second = new LivingMemoryVectorIndexOwnershipLock(
            lockPath,
            () => {}
        )
        await first.acquire()
        await assert.rejects(second.acquire(), /held by another process/u)
        await first.release()

        await writeFile(
            lockPath,
            JSON.stringify({ pid: 2_147_483_647, token: 'stale-owner' })
        )
        const staleTime = new Date(Date.now() - 120_000)
        await utimes(lockPath, staleTime, staleTime)
        await second.acquire()
        await second.release()
    })
})
