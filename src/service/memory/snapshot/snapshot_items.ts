import type {
    AgenticMemorySnapshotItem,
    MemoryReference,
    MemorySnapshotItem
} from '../../../contracts/memory'

export const isMemoryReferenceItem = (
    item: MemorySnapshotItem
): item is MemoryReference => {
    return 'memoryId' in item
}

export const isAgenticMemorySnapshotItem = (
    item: MemorySnapshotItem
): item is AgenticMemorySnapshotItem => {
    return 'finalText' in item
}
