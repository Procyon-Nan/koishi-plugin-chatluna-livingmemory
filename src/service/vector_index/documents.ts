import type { MemoryIndexSourceRecord } from '../../contracts/vector_index'
import type { VectorIndexDocument } from './worker_protocol'
import { createMemoryIndexHashes } from './hashes'

export const createVectorIndexDocument = (
    source: MemoryIndexSourceRecord
): VectorIndexDocument => ({
    memoryId: source.id,
    presetId: source.presetId,
    status: source.status,
    type: source.type,
    isConsolidated: source.isConsolidated,
    ...createMemoryIndexHashes(source),
    keywords: source.keywords,
    updatedAt: +source.updatedAt
})
