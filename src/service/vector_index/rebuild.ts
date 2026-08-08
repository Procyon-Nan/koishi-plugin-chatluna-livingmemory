import { performance } from 'node:perf_hooks'
import type {
    LegacyMemoryEmbeddingRecord,
    MemoryIndexSourceRecord,
    MemoryVectorIndexManifest
} from '../../contracts/vector_index'
import { summarizeError } from '../shared/utils'
import { createVectorIndexDocument } from './documents'
import {
    embedMemoryIndexSources,
    type EmbeddingsLike
} from './embedding'
import { LivingMemoryVectorIndexError } from './errors'
import type { LivingMemoryVectorIndexWorkerClient } from './worker_client'
import type {
    VectorIndexInspection,
    VectorIndexReplaceUpsert
} from './worker_protocol'

const REBUILD_PAGE_SIZE = 50

export interface VectorIndexRebuildRepository {
    listEntryIndexSourcePage(
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]>
    listLegacyEmbeddingPage(
        afterId: string | null,
        limit: number
    ): Promise<LegacyMemoryEmbeddingRecord[]>
    listEntryPresetIds(): Promise<string[]>
    countEntriesByPreset(presetId: string): Promise<number>
}

export type VectorIndexRebuildWorker = Pick<
    LivingMemoryVectorIndexWorkerClient,
    | 'abortRebuild'
    | 'appendRebuildBatch'
    | 'createRebuildFile'
    | 'markPresetState'
>

export interface VectorIndexRebuildProgress {
    completed: number
    total: number
    batchDuration: number
    totalDuration: number
}

const groupUpsertsByPreset = (
    upserts: VectorIndexReplaceUpsert[]
) => {
    const grouped = new Map<string, VectorIndexReplaceUpsert[]>()
    for (const upsert of upserts) {
        const presetId = upsert.document.presetId
        let group = grouped.get(presetId)
        if (group === undefined) {
            group = []
            grouped.set(presetId, group)
        }
        group.push(upsert)
    }
    return grouped
}

export const rebuildVectorIndex = async (options: {
    repository: VectorIndexRebuildRepository
    worker: VectorIndexRebuildWorker
    embeddings: EmbeddingsLike
    embeddingModelId: string
    dimension: number
    reuseLegacyEmbeddings: boolean
    manifest: MemoryVectorIndexManifest
    rebuildDatabasePath: string
    finalize: () => Promise<VectorIndexInspection>
    onProgress: (progress: VectorIndexRebuildProgress) => Promise<void>
    shouldStop: () => boolean
}) => {
    const {
        repository,
        worker,
        embeddings,
        embeddingModelId,
        dimension,
        reuseLegacyEmbeddings,
        manifest,
        rebuildDatabasePath,
        finalize,
        onProgress,
        shouldStop
    } = options
    let rebuildCreated = false
    try {
        const created = await worker.createRebuildFile(
            rebuildDatabasePath,
            manifest
        )
        rebuildCreated = true
        if (created.sqliteVecVersion !== manifest.sqliteVecVersion) {
            throw new Error(
                `sqlite-vec version mismatch: ` +
                    `expected=${manifest.sqliteVecVersion}, ` +
                    `actual=${created.sqliteVecVersion}`
            )
        }
        const presetIds = await repository.listEntryPresetIds()
        const expectedByPreset = new Map<string, number>()
        for (const presetId of presetIds) {
            const expectedCount =
                await repository.countEntriesByPreset(presetId)
            expectedByPreset.set(presetId, expectedCount)
            await worker.markPresetState({
                presetId,
                state: 'building',
                expectedCount,
                indexedCount: 0,
                lastError: null,
                updatedAt: Date.now()
            })
        }

        const total = [...expectedByPreset.values()].reduce(
            (sum, count) => sum + count,
            0
        )
        const startedAt = performance.now()
        let completed = 0
        let cursor: string | null = null
        do {
            if (shouldStop()) {
                throw new Error('vector index service is stopping')
            }
            const batchStartedAt = performance.now()
            const sources = await repository.listEntryIndexSourcePage(
                cursor,
                REBUILD_PAGE_SIZE
            )
            if (sources.length === 0) {
                break
            }

            let legacy: LegacyMemoryEmbeddingRecord[] = []
            if (reuseLegacyEmbeddings) {
                legacy = await repository.listLegacyEmbeddingPage(
                    cursor,
                    REBUILD_PAGE_SIZE
                )
            }
            const legacyById = new Map(
                legacy.map((record) => [record.id, record])
            )
            const vectors = await embedMemoryIndexSources(
                embeddings,
                embeddingModelId,
                dimension,
                sources,
                legacyById
            )
            const upserts: VectorIndexReplaceUpsert[] = []
            for (const source of sources) {
                const vector = vectors.get(source.id)
                if (vector === undefined) {
                    throw new Error(
                        `vector index embedding missing: memory=${source.id}`
                    )
                }
                upserts.push({
                    vectorAction: 'replace',
                    document: createVectorIndexDocument(source),
                    vector
                })
            }

            for (const [presetId, group] of groupUpsertsByPreset(upserts)) {
                let expectedCount = expectedByPreset.get(presetId)
                if (expectedCount === undefined) {
                    expectedCount =
                        await repository.countEntriesByPreset(presetId)
                    expectedByPreset.set(presetId, expectedCount)
                }
                const result = await worker.appendRebuildBatch(
                    presetId,
                    group
                )
                await worker.markPresetState({
                    presetId,
                    state: 'building',
                    expectedCount,
                    indexedCount: result.indexedCount,
                    lastError: null,
                    updatedAt: Date.now()
                })
            }

            completed += sources.length
            const finishedAt = performance.now()
            await onProgress({
                completed,
                total,
                batchDuration: finishedAt - batchStartedAt,
                totalDuration: finishedAt - startedAt
            })
            cursor = sources[sources.length - 1].id
        } while (true)

        return await finalize()
    } catch (error) {
        let cleanupError: unknown = null
        if (rebuildCreated) {
            try {
                await worker.abortRebuild()
            } catch (abortError) {
                cleanupError = abortError
            }
        }
        let message = summarizeError(error)
        if (cleanupError !== null) {
            message += `; rebuild cleanup failed: ${summarizeError(cleanupError)}`
        }
        throw new LivingMemoryVectorIndexError(
            'rebuild-failed',
            'unavailable',
            `vector index rebuild failed: ${message}`,
            { cause: error }
        )
    }
}
