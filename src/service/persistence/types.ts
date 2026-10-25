import type { Context } from 'koishi'
import type {
    MemoryEntryRecord,
    PresetSpeakerRecord
} from '../../contracts/memory'

/** 事务回调收到的数据库句柄；所有持久化写入共用同一类型。 */
export type LivingMemoryTransaction = Parameters<
    Parameters<Context['database']['transact']>[0]
>[0]

/** 由 `LivingMemoryRepository` 注入的串行事务入口。 */
export type LivingMemoryTransact = <T>(
    callback: (database: LivingMemoryTransaction) => Promise<T>
) => Promise<T>

export interface LivingMemoryEntryTableRecord extends MemoryEntryRecord {
    embedding: number[] | null
    embeddingModelId: string | null
}

export interface LivingMemoryEntrySpeakerRecord {
    id: string
    presetId: string
    speakerKey: string
    memoryId: string
}

export interface PresetSpeakerTableRecord extends Omit<
    PresetSpeakerRecord,
    'speakerAliases'
> {
    speakerAliases: string[] | null
}
