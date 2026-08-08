import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import { HDBSCAN } from 'hdbscan-ts'

const HDBSCAN_MIN_CLUSTER_SIZE = 2
const HDBSCAN_MIN_SAMPLES = 1

export type DreamHdbscanRunner = (vectors: number[][]) => number[]

export const runDreamHdbscan: DreamHdbscanRunner = (vectors) => {
    const hdbscan = new HDBSCAN({
        minClusterSize: HDBSCAN_MIN_CLUSTER_SIZE,
        minSamples: HDBSCAN_MIN_SAMPLES
    })
    return hdbscan.fit(vectors)
}

// 单位向量的欧氏距离与余弦距离单调等价，可直接复用库内置的欧氏距离。
const l2Normalize = (vector: Float32Array<ArrayBuffer>): number[] => {
    let normSq = 0
    for (const value of vector) {
        normSq += value * value
    }
    const norm = Math.sqrt(normSq)
    return Array.from(vector, (value) => value / norm)
}

export const readNormalizedVectors = (
    entries: readonly DreamMemoryEntryRecord[],
    vectorById: ReadonlyMap<string, Float32Array<ArrayBuffer>>
) => entries.map((entry) => l2Normalize(vectorById.get(entry.id)!))

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
    entries: readonly DreamMemoryEntryRecord[],
    labels: readonly number[]
) => {
    validateHdbscanLabels(labels, entries.length)
    const groups = new Map<number, DreamMemoryEntryRecord[]>()
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
