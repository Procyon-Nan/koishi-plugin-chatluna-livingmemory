import type { MemoryEntryRecord } from '../../contracts/memory'

export interface LivingMemoryEntryTableRecord extends MemoryEntryRecord {
    embedding: number[] | null
    embeddingModelId: string | null
}
