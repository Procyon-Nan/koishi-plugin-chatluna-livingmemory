import { LivingMemoryCheckedMemoryTool } from './checked_memory_tool'
import { LivingMemoryCreateMemoryTool } from './create_memory_tool'
import { LivingMemoryDeleteMemoryTool } from './delete_memory_tool'
import { LivingMemorySearchTool } from './search_memory_tool'
import { LivingMemoryGetMessagesTool } from './get_messages_tool'
import { LivingMemoryMergeMemoriesTool } from './merge_memories_tool'
import { LivingMemorySplitMemoryTool } from './split_memory_tool'
import { LivingMemoryUpdateMemoryTool } from './update_memory_tool'
import { LivingMemoryPassTool } from './pass_tool'
import { LivingMemoryUpdateSnapshotTool } from './update_snapshot_tool'

export const createMemoryTool = {
    pass: () => new LivingMemoryPassTool(),
    updateSnapshot: (
        ...args: ConstructorParameters<typeof LivingMemoryUpdateSnapshotTool>
    ) => new LivingMemoryUpdateSnapshotTool(...args),
    search: (...args: ConstructorParameters<typeof LivingMemorySearchTool>) =>
        new LivingMemorySearchTool(...args),
    getMessages: (
        ...args: ConstructorParameters<typeof LivingMemoryGetMessagesTool>
    ) => new LivingMemoryGetMessagesTool(...args),
    create: (
        ...args: ConstructorParameters<typeof LivingMemoryCreateMemoryTool>
    ) => new LivingMemoryCreateMemoryTool(...args),
    update: (
        ...args: ConstructorParameters<typeof LivingMemoryUpdateMemoryTool>
    ) => new LivingMemoryUpdateMemoryTool(...args),
    merge: (
        ...args: ConstructorParameters<typeof LivingMemoryMergeMemoriesTool>
    ) => new LivingMemoryMergeMemoriesTool(...args),
    split: (
        ...args: ConstructorParameters<typeof LivingMemorySplitMemoryTool>
    ) => new LivingMemorySplitMemoryTool(...args),
    delete: (
        ...args: ConstructorParameters<typeof LivingMemoryDeleteMemoryTool>
    ) => new LivingMemoryDeleteMemoryTool(...args),
    checked: (
        ...args: ConstructorParameters<typeof LivingMemoryCheckedMemoryTool>
    ) => new LivingMemoryCheckedMemoryTool(...args)
}
