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
    modelId: string
): entry is MemoryEntryRecord & { embedding: number[] } => {
    return (
        Array.isArray(entry.embedding) &&
        entry.embedding.length > 0 &&
        entry.embeddingModelId === modelId
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
        if (isCachedVectorValid(entry, modelId)) {
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
