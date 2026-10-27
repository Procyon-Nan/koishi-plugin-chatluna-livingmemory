import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord,
    MemorySearchStatus
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
    | 'sourceConversationId'
    | 'status'
    | 'type'
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
    sourceConversationId: string | null
    status: MemoryEntryStatus
    type: MemoryEntryType
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

export interface MemoryHybridSearchHit {
    memoryId: string
    cosineScore: number
    keywordMatchCount: number
    boostedScore: number
}

export interface MemoryHybridSearchInput {
    presetId: string
    conversationId?: string
    excludedMemoryIds?: string[]
    searchTexts: string[]
    memoryTypes: MemoryEntryType[] | null
    memoryStatus: MemorySearchStatus
    maxCandidates: number
    keywords: string[]
    minSimilarity: number
}

export interface MemoryVectorSearch {
    searchHybrid(
        input: MemoryHybridSearchInput
    ): Promise<MemoryHybridSearchHit[]>
}

export interface VectorSnapshot {
    embeddingModelId: string
    dimension: number
    generation: string
    items: {
        memoryId: string
        contentHash: string
        status: MemoryEntryStatus
        vector: Float32Array<ArrayBuffer>
    }[]
    missingMemoryIds: string[]
}

export interface DreamVectorProvider {
    readVectorSnapshot(
        presetId: string,
        memoryIds: string[],
        signal?: AbortSignal
    ): Promise<VectorSnapshot>
    queryDreamNeighbors(
        queries: DreamNeighborQuery[],
        signal?: AbortSignal
    ): Promise<DreamNeighborPageResult>
}

export interface DreamNeighborQuery {
    sourceIndex: number
    presetId: string
    generation: string
    sourceMemoryId: string
    vector: Float32Array<ArrayBuffer>
    limit: number
    efSearch: number
}

export interface DreamNeighborHit {
    memoryId: string
    contentHash: string
}

export interface DreamNeighborPageResult {
    generation: string
    completed: number
    available: boolean
    rows: { sourceIndex: number; hits: DreamNeighborHit[] }[]
    reason?: 'index-absent' | 'budget'
}

export interface MemoryIndexMutationSink {
    waitForMaintenance(): Promise<void>
    assertPresetReady(presetId: string): void
    applyMutation(batch: MemoryIndexMutationBatch): Promise<void>
    clearPreset(presetId: string): Promise<void>
    reconcilePreset(presetId: string, reason: string): Promise<MemoryJobRecord>
}
