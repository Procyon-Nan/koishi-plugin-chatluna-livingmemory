import type {
    MemoryEntryRecord,
    PresetSpeakerRecord
} from '../../contracts/memory'

export interface LivingMemoryEntryTableRecord extends MemoryEntryRecord {
    embedding: number[] | null
    embeddingModelId: string | null
}

export interface PresetSpeakerTableRecord
    extends Omit<PresetSpeakerRecord, 'speakerAliases'> {
    speakerAliases: string[] | null
}
