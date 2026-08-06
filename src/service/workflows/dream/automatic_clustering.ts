import type { MemoryEntryRecord } from '../../../contracts/memory'
import type { DreamCluster } from './types'
import {
    type DreamHdbscanRunner,
    readNormalizedVectors,
    runDreamHdbscan,
    validateHdbscanLabels
} from './hdbscan'
import {
    AUTO_DREAM_MAX_CLUSTER_SIZE,
    AUTO_DREAM_MAX_CLUSTERS,
    toTimestamp
} from './util'

interface AutomaticHdbscanGroup {
    label: number
    entries: MemoryEntryRecord[]
    cohesion: number
}

const groupByLabel = (
    entries: readonly MemoryEntryRecord[],
    labels: number[],
    probabilities: number[]
) => {
    validateHdbscanLabels(labels, entries.length)
    const byLabel = new Map<
        number,
        { entries: MemoryEntryRecord[]; probabilitySum: number }
    >()

    entries.forEach((entry, index) => {
        const label = labels[index]
        if (label === -1) {
            return
        }
        const probability = Number.isFinite(probabilities[index])
            ? probabilities[index]
            : 0
        const group = byLabel.get(label)
        if (group == null) {
            byLabel.set(label, {
                entries: [entry],
                probabilitySum: probability
            })
        } else {
            group.entries.push(entry)
            group.probabilitySum += probability
        }
    })

    return [...byLabel.entries()].map(
        ([label, { entries: groupEntries, probabilitySum }]) => ({
            label,
            entries: groupEntries,
            cohesion: probabilitySum / groupEntries.length
        })
    )
}

const scoreCluster = (group: AutomaticHdbscanGroup) => {
    const importanceScore =
        group.entries.reduce(
            (sum, entry) => sum + (entry.importance ?? 0.5),
            0
        ) / group.entries.length
    const latestTimestamp = Math.max(
        ...group.entries.map((entry) => toTimestamp(entry.updatedAt))
    )
    return group.cohesion * 10 + importanceScore + latestTimestamp / 1e15
}

const toAutomaticDreamClusters = (
    groups: AutomaticHdbscanGroup[]
): DreamCluster[] => {
    const sortedGroups = groups.sort(
        (left, right) => scoreCluster(right) - scoreCluster(left)
    )
    const clusters: DreamCluster[] = []

    for (const group of sortedGroups) {
        const sortedEntries = [...group.entries].sort(
            (left, right) =>
                toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt)
        )
        for (
            let index = 0;
            index < sortedEntries.length;
            index += AUTO_DREAM_MAX_CLUSTER_SIZE
        ) {
            clusters.push({
                id: `cluster-${clusters.length + 1}`,
                reason: `hdbscan:${group.label}`,
                entries: sortedEntries.slice(
                    index,
                    index + AUTO_DREAM_MAX_CLUSTER_SIZE
                )
            })
            if (clusters.length >= AUTO_DREAM_MAX_CLUSTERS) {
                return clusters
            }
        }
    }
    return clusters
}

export const buildAutomaticDreamClustersFromVectors = (
    entries: MemoryEntryRecord[],
    vectorById: ReadonlyMap<string, number[]>,
    debug: (message: string) => void,
    runHdbscan: DreamHdbscanRunner = runDreamHdbscan
) => {
    const result = runHdbscan(readNormalizedVectors(entries, vectorById))
    const distinctClusters = new Set(
        result.labels.filter((label) => label !== -1)
    )
    const noiseCount = result.labels.filter((label) => label === -1).length
    debug(
        [
            `memory dream automatic hdbscan: entries=${entries.length}`,
            `clusters=${distinctClusters.size}`,
            `noise=${noiseCount}`
        ].join(' ')
    )

    const groups = groupByLabel(entries, result.labels, result.probabilities)
    if (groups.length === 0) {
        debug('memory dream automatic hdbscan: all points classified as noise')
        return []
    }
    return toAutomaticDreamClusters(groups)
}
