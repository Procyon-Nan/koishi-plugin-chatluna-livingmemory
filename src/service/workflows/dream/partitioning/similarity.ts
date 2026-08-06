import type { MemoryEntryRecord } from '../../../../contracts/memory'
import { normalizeMemoryKeywords } from '../../../memory/entry_fields'

export const compareEntryIds = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0

export const buildSimilarityData = (entries: readonly MemoryEntryRecord[]) => {
    const entryCount = entries.length
    const similarities = new Uint8Array(entryCount * entryCount)
    const degrees = new Uint32Array(entryCount)
    const postingLists = new Map<string, number[]>()

    // 倒排索引只遍历共享关键词的条目对，矩阵负责后续阶段的常数时间查询。
    entries.forEach((entry, index) => {
        for (const keyword of normalizeMemoryKeywords(entry.keywords)) {
            const postingList = postingLists.get(keyword)
            if (postingList == null) {
                postingLists.set(keyword, [index])
            } else {
                postingList.push(index)
            }
        }
    })

    for (const postingList of postingLists.values()) {
        for (let leftIndex = 0; leftIndex < postingList.length; leftIndex++) {
            const left = postingList[leftIndex]
            for (
                let rightIndex = leftIndex + 1;
                rightIndex < postingList.length;
                rightIndex++
            ) {
                const right = postingList[rightIndex]
                similarities[left * entryCount + right]++
                similarities[right * entryCount + left]++
                degrees[left]++
                degrees[right]++
            }
        }
    }

    return { degrees, similarities }
}

export const similarityAt = (
    similarities: Uint8Array,
    entryCount: number,
    left: number,
    right: number
) => similarities[left * entryCount + right]

export const calculatePartitionQuality = (
    batches: readonly number[][],
    similarities: Uint8Array,
    entryCount: number
) => {
    let quality = 0
    for (const batch of batches) {
        for (let leftIndex = 0; leftIndex < batch.length; leftIndex++) {
            for (
                let rightIndex = leftIndex + 1;
                rightIndex < batch.length;
                rightIndex++
            ) {
                quality += similarityAt(
                    similarities,
                    entryCount,
                    batch[leftIndex],
                    batch[rightIndex]
                )
            }
        }
    }
    return quality
}
