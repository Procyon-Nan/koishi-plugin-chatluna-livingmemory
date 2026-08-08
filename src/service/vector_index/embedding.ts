import type {
    LegacyMemoryEmbeddingRecord,
    MemoryIndexSourceRecord
} from '../../contracts/vector_index'
import type { EmbeddingsLike } from '../shared/embeddings'

const VECTOR_INDEX_PROBE_TEXT = 'living memory vector index dimension probe'

export interface VectorIndexEmbeddingContext {
    embeddings: EmbeddingsLike
    embeddingModelId: string
    dimension: number
}

const convertValidVector = (
    vector: number[] | null,
    dimension: number
): Float32Array<ArrayBuffer> | null => {
    if (
        vector === null ||
        vector.length !== dimension ||
        vector.some((value) => !Number.isFinite(value))
    ) {
        return null
    }
    const converted = new Float32Array(vector)
    if (
        converted.some((value) => !Number.isFinite(value)) ||
        !converted.some((value) => value !== 0)
    ) {
        return null
    }
    return converted
}

export const createVectorIndexVector = (
    vector: number[],
    dimension: number,
    subject: string
) => {
    const converted = convertValidVector(vector, dimension)
    if (converted === null) {
        throw new Error(
            `vector index embedding invalid: ${subject}, dimension=${dimension}`
        )
    }
    return converted
}

export const probeVectorIndexDimension = async (embeddings: EmbeddingsLike) => {
    const vectors = await embeddings.embedDocuments([VECTOR_INDEX_PROBE_TEXT])
    if (vectors.length !== 1 || vectors[0].length === 0) {
        throw new Error('vector index embedding probe returned no vector')
    }
    createVectorIndexVector(
        vectors[0],
        vectors[0].length,
        'subject=dimension-probe'
    )
    return vectors[0].length
}

export const embedMemoryIndexSources = async (
    embeddings: EmbeddingsLike,
    modelId: string,
    dimension: number,
    sources: MemoryIndexSourceRecord[],
    legacyById: ReadonlyMap<string, LegacyMemoryEmbeddingRecord>
) => {
    const vectors = new Map<string, Float32Array<ArrayBuffer>>()
    const pending: MemoryIndexSourceRecord[] = []
    for (const source of sources) {
        const legacy = legacyById.get(source.id)
        let legacyVector: Float32Array<ArrayBuffer> | null = null
        if (legacy !== undefined) {
            legacyVector = convertValidVector(legacy.embedding, dimension)
        }
        if (
            legacy !== undefined &&
            legacy.embeddingModelId === modelId &&
            legacyVector !== null
        ) {
            vectors.set(source.id, legacyVector)
        } else {
            pending.push(source)
        }
    }

    if (pending.length === 0) {
        return vectors
    }
    const generated = await embeddings.embedDocuments(
        pending.map((source) => source.content)
    )
    if (generated.length !== pending.length) {
        throw new Error(
            `vector index embedding count mismatch: ` +
                `expected=${pending.length}, actual=${generated.length}`
        )
    }
    for (let index = 0; index < pending.length; index++) {
        const source = pending[index]
        vectors.set(
            source.id,
            createVectorIndexVector(
                generated[index],
                dimension,
                `memory=${source.id}`
            )
        )
    }
    return vectors
}
