import type { MemoryEntryStatus, MemoryEntryType } from '../../contracts/memory'
import type {
    MemoryVectorIndexManifest,
    MemoryVectorIndexPresetStatus
} from '../../contracts/vector_index'

export interface VectorIndexInspection {
    vectorExtensionVersion: string
    manifest: MemoryVectorIndexManifest | null
    indexedCount: number
    inventory: {
        presetId: string
        indexedCount: number
    }[]
    presets: MemoryVectorIndexPresetStatus[]
}

export interface VectorIndexInventoryItem {
    memoryId: string
    presetId: string
    status: MemoryEntryStatus
    type: MemoryEntryType
    isConsolidated: boolean
    contentHash: string
    keywordsHash: string
    updatedAt: number
}

export interface VectorIndexDocument extends VectorIndexInventoryItem {
    keywords: string[]
}

export interface VectorIndexReplaceUpsert {
    vectorAction: 'replace'
    document: VectorIndexDocument
    vector: Float32Array<ArrayBuffer>
}

export interface VectorIndexPreserveUpsert {
    vectorAction: 'preserve'
    document: VectorIndexDocument
}

export type VectorIndexUpsert =
    VectorIndexReplaceUpsert | VectorIndexPreserveUpsert

export interface VectorIndexMutation {
    presetId: string
    upserts: VectorIndexUpsert[]
    deletes: string[]
}

export interface VectorIndexFilter {
    presetId: string
    status: MemoryEntryStatus
    types: MemoryEntryType[] | null
    isConsolidated: boolean | null
}

export interface VectorIndexKnnQuery extends VectorIndexFilter {
    vector: Float32Array<ArrayBuffer>
    limit: number
}

export interface VectorIndexHybridQuery extends VectorIndexKnnQuery {
    keywords: string[]
    minSimilarity: number
}

export interface VectorIndexKnnHit {
    memoryId: string
    cosineScore: number
}

export interface VectorIndexHybridHit extends VectorIndexKnnHit {
    keywordMatchCount: number
    boostedScore: number
}

export interface VectorIndexReadVectorsResult {
    vectors: {
        memoryId: string
        vector: Float32Array<ArrayBuffer>
    }[]
    missingMemoryIds: string[]
}

export interface VectorIndexInventoryPage {
    items: VectorIndexInventoryItem[]
    nextCursor: string | null
}

export interface VectorIndexWorkerCommandMap {
    open: {
        input: {
            databaseDirectory: string
            previousDatabaseDirectory: string
        }
        result: VectorIndexInspection
    }
    inspect: {
        input: Record<never, never>
        result: VectorIndexInspection
    }
    queryKnn: {
        input: VectorIndexKnnQuery
        result: VectorIndexKnnHit[]
    }
    queryHybrid: {
        input: VectorIndexHybridQuery
        result: VectorIndexHybridHit[]
    }
    readVectors: {
        input: { presetId: string; memoryIds: string[] }
        result: VectorIndexReadVectorsResult
    }
    applyMutation: {
        input: VectorIndexMutation
        result: { indexedCount: number }
    }
    clearPreset: {
        input: { presetId: string }
        result: { deletedCount: number }
    }
    readInventoryPage: {
        input: {
            presetId: string | null
            afterMemoryId: string | null
            limit: number
        }
        result: VectorIndexInventoryPage
    }
    markPresetState: {
        input: MemoryVectorIndexPresetStatus
        result: MemoryVectorIndexPresetStatus
    }
    createRebuildFile: {
        input: {
            databaseDirectory: string
            manifest: MemoryVectorIndexManifest
        }
        result: VectorIndexInspection
    }
    appendRebuildBatch: {
        input: {
            presetId: string
            upserts: VectorIndexReplaceUpsert[]
        }
        result: { indexedCount: number }
    }
    finalizeRebuild: {
        input: {
            previousDatabaseDirectory: string
            expectedCount: number
        }
        result: VectorIndexInspection
    }
    abortRebuild: {
        input: Record<never, never>
        result: VectorIndexInspection
    }
    dispose: {
        input: Record<never, never>
        result: { disposed: true }
    }
}

export type VectorIndexWorkerCommandName = keyof VectorIndexWorkerCommandMap

export type VectorIndexWorkerCommand<
    Name extends VectorIndexWorkerCommandName = VectorIndexWorkerCommandName
> = Name extends VectorIndexWorkerCommandName
    ? { type: Name } & VectorIndexWorkerCommandMap[Name]['input']
    : never

export type VectorIndexWorkerResult<Name extends VectorIndexWorkerCommandName> =
    VectorIndexWorkerCommandMap[Name]['result']

export interface VectorIndexWorkerRequest<
    Name extends VectorIndexWorkerCommandName = VectorIndexWorkerCommandName
> {
    id: number
    command: VectorIndexWorkerCommand<Name>
}

export interface VectorIndexWorkerError {
    name: string
    message: string
    stack: string | null
}

export type VectorIndexWorkerResponse = {
    [Name in VectorIndexWorkerCommandName]:
        | {
              id: number
              type: Name
              ok: true
              result: VectorIndexWorkerResult<Name>
          }
        | {
              id: number
              type: Name
              ok: false
              error: VectorIndexWorkerError
          }
}[VectorIndexWorkerCommandName]
