import type { AgenticMemorySnapshotItem } from '../../../contracts/memory'

export const renderSnapshotText = (
    items: readonly AgenticMemorySnapshotItem[]
) => {
    return items
        .map((item) => item.finalText.trim())
        .filter((text) => text.length > 0)
        .join('\n')
}
