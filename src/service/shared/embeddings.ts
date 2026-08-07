import type { MemoryEntryRecord } from '../../contracts/memory'
import { cosineSimilarity } from './utils'

export interface EmbeddingsLike {
    embedDocuments(texts: string[]): Promise<number[][]>
    embedQuery(text: string): Promise<number[]>
}

export interface EmbeddingEntryUpdate {
    id: string
    embedding: number[]
    embeddingModelId: string
}

export interface EmbeddingRepositoryLike {
    updateEntryEmbeddings(updates: EmbeddingEntryUpdate[]): Promise<void>
}

interface EnsureEntryEmbeddingsBaseOptions {
    debug?: (message: string) => void
    // 当前模型输出的向量维度。传入后，已缓存但维度不匹配的旧向量会被判为
    // 失效并重算，以规避模型在同一标识下变更维度时 cosine 静默返回 0 的问题。
    // 未提供时只校验向量本身，不校验维度。
    expectedDimension?: number
}

export type EnsureEntryEmbeddingsOptions =
    | (EnsureEntryEmbeddingsBaseOptions & {
          persistenceFailure: 'warn'
          logger: { warn: (message: unknown) => void }
      })
    | (EnsureEntryEmbeddingsBaseOptions & {
          persistenceFailure: 'throw'
      })

export const toMemoryRetrievalText = (
    entry: Pick<MemoryEntryRecord, 'content'>
) => {
    return entry.content
}

const isCachedVectorValid = (
    entry: MemoryEntryRecord,
    modelId: string,
    expectedDimension?: number
): entry is MemoryEntryRecord & { embedding: number[] } => {
    return (
        entry.embeddingModelId === modelId &&
        isEmbeddingVectorValid(entry.embedding, expectedDimension)
    )
}

const isEmbeddingVectorValid = (
    vector: unknown,
    expectedDimension?: number
): vector is number[] => {
    if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        (expectedDimension !== undefined &&
            vector.length !== expectedDimension) ||
        vector.some((value) => !Number.isFinite(value))
    ) {
        return false
    }

    return vector.some((value) => value !== 0)
}

export async function ensureEntryEmbeddings(
    embeddings: EmbeddingsLike,
    repository: EmbeddingRepositoryLike,
    modelId: string,
    entries: MemoryEntryRecord[],
    options: EnsureEntryEmbeddingsOptions
): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>()
    const stale: MemoryEntryRecord[] = []

    for (const entry of entries) {
        if (isCachedVectorValid(entry, modelId, options.expectedDimension)) {
            result.set(entry.id, entry.embedding)
        } else {
            stale.push(entry)
        }
    }

    if (stale.length === 0) {
        return result
    }

    options.debug?.(
        `memory embedding backfill: model=${modelId}, count=${stale.length}`
    )

    const vectors = await embeddings.embedDocuments(
        stale.map((entry) => toMemoryRetrievalText(entry))
    )
    if (vectors.length !== stale.length) {
        throw new Error(
            `memory embedding count mismatch: expected=${stale.length}, actual=${vectors.length}`
        )
    }

    const updates: EmbeddingEntryUpdate[] = []
    stale.forEach((entry, index) => {
        const vector = vectors[index]!
        if (!isEmbeddingVectorValid(vector, options.expectedDimension)) {
            throw new Error(`memory embedding invalid: id=${entry.id}`)
        }
        result.set(entry.id, vector)
        entry.embedding = vector
        entry.embeddingModelId = modelId
        updates.push({
            id: entry.id,
            embedding: vector,
            embeddingModelId: modelId
        })
    })

    try {
        await repository.updateEntryEmbeddings(updates)
    } catch (error) {
        if (options.persistenceFailure === 'throw') {
            throw error
        }
        options.logger.warn(error)
    }

    return result
}

export interface ScoredEntry {
    entry: MemoryEntryRecord
    score: number
}

/**
 * 对每条记忆计算与查询向量的余弦相似度，按分数降序排列。
 * 向量缺失或维度不匹配时 throw，与 LivingMemoryRetriever 原有行为一致。
 */
export const rankEntriesByQueryVector = (
    entries: readonly MemoryEntryRecord[],
    embeddingMap: Map<string, number[]>,
    queryVector: number[]
): ScoredEntry[] => {
    return entries
        .map((entry) => {
            const vector = embeddingMap.get(entry.id)
            if (vector == null || vector.length !== queryVector.length) {
                throw new Error(`entry embedding invalid: id=${entry.id}`)
            }

            return {
                entry,
                score: cosineSimilarity(queryVector, vector)
            }
        })
        .sort((left, right) => right.score - left.score)
}
