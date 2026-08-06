import type { MemoryEntryRecord } from '../../../contracts/memory'
import type { DreamCluster } from './types'
import {
    type DreamHdbscanRunner,
    groupEntriesByLabel,
    readNormalizedVectors,
    runDreamHdbscan
} from './hdbscan'

export const buildManualDreamClustersFromVectors = (
    partitions: readonly MemoryEntryRecord[][],
    vectorById: ReadonlyMap<string, number[]>,
    runHdbscan: DreamHdbscanRunner = runDreamHdbscan
): DreamCluster[] => {
    const clusters: DreamCluster[] = []
    const firstPassNoise: MemoryEntryRecord[] = []
    const appendCluster = (reason: string, entries: MemoryEntryRecord[]) => {
        clusters.push({
            id: `cluster-${clusters.length + 1}`,
            reason,
            entries
        })
    }

    // 首轮只冻结各关键词批次的非噪声簇，noise 留到全部批次完成后统一处理。
    partitions.forEach((partition, partitionIndex) => {
        const result = runHdbscan(readNormalizedVectors(partition, vectorById))
        const groups = groupEntriesByLabel(partition, result.labels)
        for (const [label, entries] of groups) {
            if (label === -1) {
                firstPassNoise.push(...entries)
            } else {
                appendCluster(
                    `hdbscan:primary:${partitionIndex + 1}:${label}`,
                    entries
                )
            }
        }
    })

    if (firstPassNoise.length === 0) {
        return clusters
    }
    if (firstPassNoise.length === 1) {
        appendCluster('hdbscan:final-noise', firstPassNoise)
        return clusters
    }

    // 第二轮直接处理全局 noise；仍未归类的条目共同形成最终 noise 单元。
    const secondPass = runHdbscan(
        readNormalizedVectors(firstPassNoise, vectorById)
    )
    const secondPassGroups = groupEntriesByLabel(
        firstPassNoise,
        secondPass.labels
    )
    const finalNoise = secondPassGroups.get(-1)
    for (const [label, entries] of secondPassGroups) {
        if (label !== -1) {
            appendCluster(`hdbscan:noise:${label}`, entries)
        }
    }
    if (finalNoise != null) {
        appendCluster('hdbscan:final-noise', finalNoise)
    }
    return clusters
}
