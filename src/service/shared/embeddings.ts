import type { MemoryEntryRecord } from '../../types'

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

export interface EnsureEntryEmbeddingsOptions {
    logger?: { warn: (message: unknown) => void }
    debug?: (message: string) => void
    // 当前模型输出的向量维度。传入后，已缓存但维度不匹配的旧向量会被判为
    // 失效并重算，以规避模型在同一标识下变更维度时 cosine 静默返回 0 的问题。
    // 为 0 或未提供时跳过维度校验，避免异常的空向量误判所有缓存失效。
    expectedDimension?: number
}

export const toMemoryRetrievalText = (
    entry: Pick<MemoryEntryRecord, 'content' | 'summary' | 'keywords'>
) => {
    return [
        `摘要：${entry.summary ?? ''}`,
        `关键词：${entry.keywords.join('、')}`,
        `内容：${entry.content}`
    ].join('\n')
}

const isCachedVectorValid = (
    entry: MemoryEntryRecord,
    modelId: string,
    expectedDimension?: number
): entry is MemoryEntryRecord & { embedding: number[] } => {
    return (
        Array.isArray(entry.embedding) &&
        entry.embedding.length > 0 &&
        entry.embeddingModelId === modelId &&
        (expectedDimension == null ||
            expectedDimension <= 0 ||
            entry.embedding.length === expectedDimension)
    )
}

export async function ensureEntryEmbeddings(
    embeddings: EmbeddingsLike,
    repository: EmbeddingRepositoryLike,
    modelId: string,
    entries: MemoryEntryRecord[],
    options: EnsureEntryEmbeddingsOptions = {}
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

    const updates: EmbeddingEntryUpdate[] = []
    stale.forEach((entry, index) => {
        const vector = vectors[index] ?? []
        result.set(entry.id, vector)
        if (vector.length > 0) {
            entry.embedding = vector
            entry.embeddingModelId = modelId
            updates.push({
                id: entry.id,
                embedding: vector,
                embeddingModelId: modelId
            })
        }
    })

    if (updates.length > 0) {
        try {
            await repository.updateEntryEmbeddings(updates)
        } catch (error) {
            options.logger?.warn(error)
        }
    }

    return result
}
