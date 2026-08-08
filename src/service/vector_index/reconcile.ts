import type {
    LegacyMemoryEmbeddingRecord,
    MemoryIndexSourceRecord,
    MemoryVectorIndexPresetStatus
} from '../../contracts/vector_index'
import { summarizeError } from '../shared/utils'
import type { LivingMemoryVectorIndexWorkerClient } from './worker_client'
import type {
    VectorIndexDocument,
    VectorIndexInventoryItem,
    VectorIndexUpsert
} from './worker_protocol'
import { createVectorIndexDocument } from './documents'
import { type EmbeddingsLike, embedMemoryIndexSources } from './embedding'
import { LivingMemoryVectorIndexError } from './errors'

const RECONCILE_PAGE_SIZE = 50
const INVENTORY_PAGE_SIZE = 500
const NO_LEGACY_EMBEDDINGS = new Map<string, LegacyMemoryEmbeddingRecord>()

export interface VectorIndexReconcileRepository {
    listEntryIndexSourcePageByPreset(
        presetId: string,
        afterId: string | null,
        limit: number
    ): Promise<MemoryIndexSourceRecord[]>
    countEntriesByPreset(presetId: string): Promise<number>
}

export type VectorIndexReconcileWorker = Pick<
    LivingMemoryVectorIndexWorkerClient,
    'applyMutation' | 'clearPreset' | 'markPresetState' | 'readInventoryPage'
>

export interface VectorIndexReconcileProgress {
    presetId: string
    completed: number
    total: number
}

const requiresMetadataUpdate = (
    document: VectorIndexDocument,
    inventory: VectorIndexInventoryItem
) => {
    return (
        inventory.keywordsHash !== document.keywordsHash ||
        inventory.status !== document.status ||
        inventory.type !== document.type ||
        inventory.isConsolidated !== document.isConsolidated ||
        inventory.updatedAt !== document.updatedAt
    )
}

const readPresetInventory = async (
    worker: VectorIndexReconcileWorker,
    presetId: string
) => {
    const inventory = new Map<string, VectorIndexInventoryItem>()
    let cursor: string | null = null
    do {
        const page = await worker.readInventoryPage(
            presetId,
            cursor,
            INVENTORY_PAGE_SIZE
        )
        for (const item of page.items) {
            inventory.set(item.memoryId, item)
        }
        cursor = page.nextCursor
    } while (cursor !== null)
    return inventory
}

const markPresetState = (
    worker: VectorIndexReconcileWorker,
    status: MemoryVectorIndexPresetStatus
) => worker.markPresetState(status)

export const reconcileVectorIndexPreset = async (options: {
    presetId: string
    repository: VectorIndexReconcileRepository
    worker: VectorIndexReconcileWorker
    embeddings: EmbeddingsLike
    embeddingModelId: string
    dimension: number
    onProgress: (progress: VectorIndexReconcileProgress) => Promise<void>
    shouldStop: () => boolean
}) => {
    const {
        presetId,
        repository,
        worker,
        embeddings,
        embeddingModelId,
        dimension,
        onProgress,
        shouldStop
    } = options
    const total = await repository.countEntriesByPreset(presetId)
    if (total === 0) {
        await worker.clearPreset(presetId)
        return
    }

    await markPresetState(worker, {
        presetId,
        state: 'building',
        expectedCount: total,
        indexedCount: 0,
        lastError: null,
        updatedAt: Date.now()
    })

    let indexedCount = 0
    try {
        const inventory = await readPresetInventory(worker, presetId)
        indexedCount = inventory.size
        let cursor: string | null = null
        let completed = 0
        do {
            if (shouldStop()) {
                throw new Error('vector index service is stopping')
            }
            const sources = await repository.listEntryIndexSourcePageByPreset(
                presetId,
                cursor,
                RECONCILE_PAGE_SIZE
            )
            if (sources.length === 0) {
                break
            }

            const replacements: {
                source: MemoryIndexSourceRecord
                document: VectorIndexDocument
            }[] = []
            const upserts: VectorIndexUpsert[] = []
            for (const source of sources) {
                const current = inventory.get(source.id)
                inventory.delete(source.id)
                const document = createVectorIndexDocument(source)
                if (
                    current === undefined ||
                    current.contentHash !== document.contentHash
                ) {
                    replacements.push({ source, document })
                    continue
                }
                if (requiresMetadataUpdate(document, current)) {
                    upserts.push({
                        vectorAction: 'preserve',
                        document
                    })
                }
            }

            const vectors = await embedMemoryIndexSources(
                embeddings,
                embeddingModelId,
                dimension,
                replacements.map(({ source }) => source),
                NO_LEGACY_EMBEDDINGS
            )
            for (const replacement of replacements) {
                const vector = vectors.get(replacement.source.id)
                if (vector === undefined) {
                    throw new Error(
                        `vector index embedding missing: memory=${replacement.source.id}`
                    )
                }
                upserts.push({
                    vectorAction: 'replace',
                    document: replacement.document,
                    vector
                })
            }
            const mutation = await worker.applyMutation({
                presetId,
                upserts,
                deletes: []
            })
            indexedCount = mutation.indexedCount
            completed += sources.length
            await onProgress({ presetId, completed, total })
            cursor = sources[sources.length - 1].id
        } while (true)

        if (inventory.size > 0) {
            const mutation = await worker.applyMutation({
                presetId,
                upserts: [],
                deletes: [...inventory.keys()]
            })
            indexedCount = mutation.indexedCount
        }
        const result = await worker.applyMutation({
            presetId,
            upserts: [],
            deletes: []
        })
        if (result.indexedCount !== total) {
            throw new Error(
                `vector index reconcile count mismatch: ` +
                    `preset=${presetId}, expected=${total}, ` +
                    `actual=${result.indexedCount}`
            )
        }
        await markPresetState(worker, {
            presetId,
            state: 'ready',
            expectedCount: total,
            indexedCount: result.indexedCount,
            lastError: null,
            updatedAt: Date.now()
        })
    } catch (error) {
        const message = summarizeError(error)
        await markPresetState(worker, {
            presetId,
            state: 'dirty',
            expectedCount: total,
            indexedCount,
            lastError: message,
            updatedAt: Date.now()
        })
        throw new LivingMemoryVectorIndexError(
            'reconcile-failed',
            'dirty',
            `vector index reconcile failed: preset=${presetId}: ${message}`,
            { cause: error }
        )
    }
}
