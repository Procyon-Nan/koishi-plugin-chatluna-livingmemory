import type {
    LegacyMemoryEmbeddingRecord,
    MemoryIndexMutationBatch
} from '../../contracts/vector_index'
import { createVectorIndexDocument } from './documents'
import {
    embedMemoryIndexSources,
    type VectorIndexEmbeddingContext
} from './embedding'
import type { VectorIndexMutation, VectorIndexUpsert } from './worker_protocol'

const NO_LEGACY_EMBEDDINGS = new Map<string, LegacyMemoryEmbeddingRecord>()

export const buildVectorIndexWorkerMutation = async (
    batch: MemoryIndexMutationBatch,
    context: VectorIndexEmbeddingContext
): Promise<VectorIndexMutation> => {
    const replacementSources = batch.upserts
        .filter((upsert) => upsert.vectorAction === 'replace')
        .map((upsert) => upsert.document)
    const replacements = await embedMemoryIndexSources(
        context.embeddings,
        context.embeddingModelId,
        context.dimension,
        replacementSources,
        NO_LEGACY_EMBEDDINGS
    )

    let replacementIndex = 0
    const upserts: VectorIndexUpsert[] = batch.upserts.map((upsert) => {
        const document = createVectorIndexDocument(upsert.document)
        if (upsert.vectorAction === 'preserve') {
            return { vectorAction: 'preserve', document }
        }
        const vector = replacements[replacementIndex++].vector
        return { vectorAction: 'replace', document, vector }
    })

    return {
        presetId: batch.presetId,
        upserts,
        deletes: batch.deletes.map((item) => item.id)
    }
}
