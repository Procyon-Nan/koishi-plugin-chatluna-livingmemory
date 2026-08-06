import type { MemoryEntryRecord } from '../../../contracts/memory'
import { HDBSCAN } from 'hdbscan-ts'
import { HDBSCAN_MIN_CLUSTER_SIZE, HDBSCAN_MIN_SAMPLES } from './util'

export interface DreamHdbscanResult {
    labels: number[]
    probabilities: number[]
}

export type DreamHdbscanRunner = (vectors: number[][]) => DreamHdbscanResult

export const runDreamHdbscan: DreamHdbscanRunner = (vectors) => {
    const hdbscan = new HDBSCAN({
        minClusterSize: HDBSCAN_MIN_CLUSTER_SIZE,
        minSamples: HDBSCAN_MIN_SAMPLES
    })
    const labels = hdbscan.fit(vectors)
    return { labels, probabilities: hdbscan.probabilities_ }
}

// 单位向量的欧氏距离与余弦距离单调等价，可直接复用库内置的欧氏距离。
const l2Normalize = (vector: number[]) => {
    let normSq = 0
    for (const value of vector) {
        normSq += value * value
    }
    const norm = Math.sqrt(normSq)
    return vector.map((value) => value / norm)
}

export const readNormalizedVectors = (
    entries: readonly MemoryEntryRecord[],
    vectorById: ReadonlyMap<string, number[]>
) =>
    entries.map((entry) => {
        const vector = vectorById.get(entry.id)
        if (vector == null) {
            throw new Error(`dream embedding missing: id=${entry.id}`)
        }
        return l2Normalize(vector)
    })

export const validateHdbscanLabels = (
    labels: readonly number[],
    entryCount: number
) => {
    if (labels.length !== entryCount) {
        throw new Error(
            `dream hdbscan returned ${labels.length} labels for ${entryCount} entries`
        )
    }
    for (const label of labels) {
        if (!Number.isInteger(label) || label < -1) {
            throw new Error(`dream hdbscan returned invalid label: ${label}`)
        }
    }
}

export const groupEntriesByLabel = (
    entries: readonly MemoryEntryRecord[],
    labels: readonly number[]
) => {
    validateHdbscanLabels(labels, entries.length)
    const groups = new Map<number, MemoryEntryRecord[]>()
    entries.forEach((entry, index) => {
        const label = labels[index]
        const group = groups.get(label)
        if (group == null) {
            groups.set(label, [entry])
        } else {
            group.push(entry)
        }
    })
    return groups
}
