import type {} from '@koishijs/plugin-console'
import type {} from 'koishi-plugin-chatluna/services/chat'
import type {
    LivingMemoryMigrationRecord,
    MemoryJobRecord,
    MemorySnapshotRecord,
    PresetSpeakerRecord,
    UserProfileRecord
} from '../contracts/memory'
import type { LivingMemoryConsoleEvents } from '../contracts/rpc'
import type { ChatLunaLivingMemoryService } from '../service/app/living_memory_service'
import type { LivingMemoryEntryTableRecord } from '../service/persistence/types'

declare module 'koishi' {
    interface Context {
        chatluna_living_memory: ChatLunaLivingMemoryService
    }

    interface Tables {
        living_memory_entry: LivingMemoryEntryTableRecord
        living_memory_migration: LivingMemoryMigrationRecord
        living_memory_snapshot: MemorySnapshotRecord
        living_memory_job: MemoryJobRecord
        living_memory_user_profile: UserProfileRecord
        living_memory_preset_speaker: PresetSpeakerRecord
    }
}

declare module '@koishijs/plugin-console' {
    interface Events extends LivingMemoryConsoleEvents {}
}
