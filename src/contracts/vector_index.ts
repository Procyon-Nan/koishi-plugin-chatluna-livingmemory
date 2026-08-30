import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord
} from './memory'

export const memoryVectorIndexStates = [
    'ready',
    'building',
    'dirty',
    'unavailable'
] as const

export type MemoryVectorIndexState = (typeof memoryVectorIndexStates)[number]

export interface MemoryVectorIndexManifest {
    schemaVersion: number
    embeddingModelId: string
    dimension: number
    storageEngine: 'pglite-pgvector'
    vectorExtensionVersion: string
    generation: string
    builtAt: number
}

export interface MemoryVectorIndexPresetStatus {
    presetId: string
    state: MemoryVectorIndexState
    expectedCount: number
    indexedCount: number
    lastError: string | null
    updatedAt: number
}

export interface MemoryVectorIndexStatus {
    state: MemoryVectorIndexState
    manifest: MemoryVectorIndexManifest | null
    presets: MemoryVectorIndexPresetStatus[]
    currentJobId: string | null
    lastError: string | null
}

export type MemoryIndexSourceRecord = Pick<
    MemoryEntryRecord,
    | 'id'
    | 'presetId'
    | 'status'
    | 'type'
    | 'isConsolidated'
    | 'content'
    | 'keywords'
    | 'updatedAt'
>

export interface LegacyMemoryEmbeddingRecord {
    id: string
    embedding: number[] | null
    embeddingModelId: string | null
}

export interface MemoryIndexDocument {
    id: string
    presetId: string
    status: MemoryEntryStatus
    type: MemoryEntryType
    isConsolidated: boolean
    content: string
    keywords: string[]
    updatedAt: Date
}

export interface MemoryIndexUpsert {
    document: MemoryIndexDocument
    vectorAction: 'replace' | 'preserve'
}

export interface MemoryIndexDelete {
    id: string
    presetId: string
}

export interface MemoryIndexMutationBatch {
    presetId: string
    upserts: MemoryIndexUpsert[]
    deletes: MemoryIndexDelete[]
}

export interface MemoryVectorSearchHit {
    memoryId: string
    cosineScore: number
}

export interface MemoryHybridSearchHit extends MemoryVectorSearchHit {
    keywordMatchCount: number
    boostedScore: number
}

export interface MemorySemanticSearchInput {
    presetId: string
    searchTexts: string[]
    status: MemoryEntryStatus
    memoryTypes: MemoryEntryType[] | null
    maxCandidates: number
}

export interface MemoryHybridSearchInput extends MemorySemanticSearchInput {
    keywords: string[]
    minSimilarity: number
}

export interface IncrementalDreamNeighborInput {
    presetId: string
    seedMemoryId: string
    excludedMemoryIds: string[]
    limit: number
}

export interface MemoryVectorSearch {
    searchSemantic(
        input: MemorySemanticSearchInput
    ): Promise<MemoryVectorSearchHit[]>
    searchHybrid(
        input: MemoryHybridSearchInput
    ): Promise<MemoryHybridSearchHit[]>
}

export interface IncrementalDreamNeighborSearch {
    assertPresetReady(presetId: string): void
    findConsolidatedNeighbors(
        input: IncrementalDreamNeighborInput
    ): Promise<string[]>
}

export interface ManualDreamVectorReader {
    readVectors(
        presetId: string,
        memoryIds: string[]
    ): Promise<Map<string, Float32Array<ArrayBuffer>>>
}

export interface MemoryIndexMutationSink {
    waitForMaintenance(): Promise<void>
    assertPresetReady(presetId: string): void
    applyMutation(batch: MemoryIndexMutationBatch): Promise<void>
    clearPreset(presetId: string): Promise<void>
    reconcilePreset(presetId: string, reason: string): Promise<MemoryJobRecord>
}
