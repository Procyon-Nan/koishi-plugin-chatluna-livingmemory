import { Context } from 'koishi'
import type { MemoryEntryRecord } from '../../../contracts/memory'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import { HDBSCAN } from 'hdbscan-ts'
import {
    type EmbeddingRepositoryLike,
    type EmbeddingsLike,
    ensureEntryEmbeddings
} from '../../shared/embeddings'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import { partitionDreamEntries } from './partitioning'
import type { DreamCluster, DreamTrigger } from './types'
import {
    HDBSCAN_MIN_CLUSTER_SIZE,
    HDBSCAN_MIN_SAMPLES,
    MAX_CLUSTER_SIZE,
    MAX_DREAM_CLUSTERS,
    toTimestamp
} from './util'

type DreamClustererConfig = Pick<LivingMemoryConfig, 'embeddingModel'>

interface HdbscanGroup {
    label: number
    entries: MemoryEntryRecord[]
    cohesion: number
}

interface EmbeddingContext {
    embeddings: EmbeddingsLike
    expectedDimension: number
}

export interface DreamHdbscanResult {
    labels: number[]
    probabilities: number[]
}

export type DreamHdbscanRunner = (vectors: number[][]) => DreamHdbscanResult

// L2 归一化后 euclidean 距离与 cosine 距离单调等价：
// ||a − b||² = 2 − 2·cos(a, b)（当 ||a|| = ||b|| = 1）。
// hdbscan-ts 内置 euclidean 距离，归一化后聚类结果与 cosine HDBSCAN 一致。
const l2Normalize = (vector: number[]): number[] => {
    let normSq = 0
    for (let i = 0; i < vector.length; i++) {
        normSq += vector[i] * vector[i]
    }
    const norm = Math.sqrt(normSq)
    if (norm === 0) {
        return vector
    }
    const result = new Array<number>(vector.length)
    for (let i = 0; i < vector.length; i++) {
        result[i] = vector[i] / norm
    }
    return result
}

export const runDreamHdbscan: DreamHdbscanRunner = (vectors) => {
    const hdbscan = new HDBSCAN({
        minClusterSize: HDBSCAN_MIN_CLUSTER_SIZE,
        minSamples: HDBSCAN_MIN_SAMPLES
    })
    const labels = hdbscan.fit(vectors)
    return { labels, probabilities: hdbscan.probabilities_ }
}

const readVectors = (
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

const groupEntriesByLabel = (
    entries: readonly MemoryEntryRecord[],
    labels: readonly number[]
) => {
    if (labels.length !== entries.length) {
        throw new Error(
            `dream hdbscan returned ${labels.length} labels for ${entries.length} entries`
        )
    }

    const groups = new Map<number, MemoryEntryRecord[]>()
    entries.forEach((entry, index) => {
        const label = labels[index]
        if (!Number.isInteger(label) || label < -1) {
            throw new Error(`dream hdbscan returned invalid label: ${label}`)
        }
        const group = groups.get(label)
        if (group == null) {
            groups.set(label, [entry])
        } else {
            group.push(entry)
        }
    })
    return groups
}

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

    partitions.forEach((partition, partitionIndex) => {
        const result = runHdbscan(readVectors(partition, vectorById))
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

    const secondPass = runHdbscan(readVectors(firstPassNoise, vectorById))
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

export class DreamClusterer {
    constructor(
        private readonly ctx: Context,
        private readonly config: DreamClustererConfig,
        private readonly repository: EmbeddingRepositoryLike,
        private readonly debug: (message: string) => void
    ) {}

    async buildClusters(
        entries: MemoryEntryRecord[],
        trigger: DreamTrigger
    ): Promise<DreamCluster[]> {
        if (entries.length < 2) {
            return []
        }

        if (trigger === 'manual') {
            return await this.buildManualClusters(entries)
        }
        return await this.buildAutomaticClusters(entries)
    }

    private async buildManualClusters(entries: MemoryEntryRecord[]) {
        const partitions = partitionDreamEntries(entries)
        const embeddingContext = await this.createEmbeddingContext(entries)
        const vectorById = new Map<string, number[]>()

        for (const partition of partitions) {
            const partitionVectors = await this.ensureVectors(
                partition,
                embeddingContext
            )
            for (const [id, vector] of partitionVectors) {
                vectorById.set(id, vector)
            }
        }

        const clusters = buildManualDreamClustersFromVectors(
            partitions,
            vectorById
        )
        this.debug(
            [
                `memory dream manual clustering: entries=${entries.length}`,
                `partitions=${partitions.length}`,
                `clusters=${clusters.length}`
            ].join(' ')
        )
        return clusters
    }

    private async buildAutomaticClusters(entries: MemoryEntryRecord[]) {
        const embeddingContext = await this.createEmbeddingContext(entries)
        const vectorById = await this.ensureVectors(entries, embeddingContext)
        const indexed = entries.map((entry) => ({
            entry,
            vector: vectorById.get(entry.id) as number[]
        }))
        const normalized = indexed.map((item) => l2Normalize(item.vector))
        const result = runDreamHdbscan(normalized)
        const distinctClusters = new Set(
            result.labels.filter((label) => label !== -1)
        )
        const noiseCount = result.labels.filter((label) => label === -1).length
        this.debug(
            [
                `memory dream hdbscan: entries=${indexed.length}`,
                `clusters=${distinctClusters.size}`,
                `noise=${noiseCount}`
            ].join(' ')
        )

        const groups = this.groupByLabel(
            indexed,
            result.labels,
            result.probabilities
        )
        if (groups.length === 0) {
            this.debug(
                'memory dream hdbscan: all points classified as noise, no clusters'
            )
            return []
        }
        return this.toDreamClusters(groups)
    }

    private async createEmbeddingContext(
        entries: readonly MemoryEntryRecord[]
    ): Promise<EmbeddingContext> {
        if (!isModelConfigured(this.config.embeddingModel)) {
            throw new Error('dream embedding model is not configured')
        }

        let embeddings
        try {
            embeddings = await this.ctx.chatluna.createEmbeddings(
                this.config.embeddingModel
            )
        } catch (error) {
            throw new Error(
                `dream embedding model creation failed: ${summarizeError(error)}`
            )
        }
        if (embeddings?.value == null) {
            throw new Error('dream embedding model is unavailable')
        }

        let probeVector: number[]
        try {
            probeVector = await embeddings.value.embedQuery(entries[0].content)
        } catch (error) {
            throw new Error(
                `dream embedding dimension probe failed: ${summarizeError(error)}`
            )
        }
        if (
            !Array.isArray(probeVector) ||
            probeVector.length === 0 ||
            probeVector.some((value) => !Number.isFinite(value))
        ) {
            throw new Error(
                'dream embedding dimension probe returned invalid vector'
            )
        }

        return {
            embeddings: embeddings.value,
            expectedDimension: probeVector.length
        }
    }

    private async ensureVectors(
        entries: MemoryEntryRecord[],
        context: EmbeddingContext
    ): Promise<Map<string, number[]>> {
        let vectors: Map<string, number[]>
        try {
            vectors = await ensureEntryEmbeddings(
                context.embeddings,
                this.repository,
                this.config.embeddingModel,
                entries,
                {
                    logger: this.ctx.logger('chatluna-livingmemory'),
                    debug: (message) => this.debug(message),
                    expectedDimension: context.expectedDimension
                }
            )
        } catch (error) {
            throw new Error(
                `dream embedding generation failed: ${summarizeError(error)}`
            )
        }

        for (const entry of entries) {
            const vector = vectors.get(entry.id)
            if (
                !Array.isArray(vector) ||
                vector.length !== context.expectedDimension ||
                vector.some((value) => !Number.isFinite(value))
            ) {
                throw new Error(`dream embedding invalid: id=${entry.id}`)
            }
            let normSq = 0
            for (const value of vector) {
                normSq += value * value
            }
            if (normSq === 0) {
                throw new Error(
                    `dream embedding is zero vector: id=${entry.id}`
                )
            }
        }
        return vectors
    }

    private groupByLabel(
        indexed: { entry: MemoryEntryRecord }[],
        labels: number[],
        probabilities: number[]
    ): HdbscanGroup[] {
        const byLabel = new Map<
            number,
            { entries: MemoryEntryRecord[]; probSum: number }
        >()

        for (let i = 0; i < indexed.length; i++) {
            const label = labels[i]
            if (label === -1) {
                continue
            }

            const prob = Number.isFinite(probabilities[i])
                ? probabilities[i]
                : 0
            const existing = byLabel.get(label)
            if (existing != null) {
                existing.entries.push(indexed[i].entry)
                existing.probSum += prob
            } else {
                byLabel.set(label, {
                    entries: [indexed[i].entry],
                    probSum: prob
                })
            }
        }

        return [...byLabel.entries()].map(([label, { entries, probSum }]) => ({
            label,
            entries,
            cohesion: entries.length > 0 ? probSum / entries.length : 0
        }))
    }

    private scoreCluster(group: HdbscanGroup) {
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

    private toDreamClusters(groups: HdbscanGroup[]): DreamCluster[] {
        const sorted = groups
            .map((group) => ({ group, score: this.scoreCluster(group) }))
            .sort((left, right) => right.score - left.score)
        const clusters: DreamCluster[] = []
        const seen = new Set<string>()

        for (const { group } of sorted) {
            const sortedEntries = [...group.entries].sort(
                (left, right) =>
                    toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt)
            )
            for (
                let index = 0;
                index < sortedEntries.length - 1;
                index += MAX_CLUSTER_SIZE
            ) {
                const chunk = sortedEntries.slice(
                    index,
                    index + MAX_CLUSTER_SIZE
                )
                const key = chunk
                    .map((entry) => entry.id)
                    .sort()
                    .join('|')
                if (seen.has(key)) {
                    continue
                }

                seen.add(key)
                clusters.push({
                    id: `cluster-${clusters.length + 1}`,
                    reason: `hdbscan:${group.label}`,
                    entries: chunk
                })
                if (clusters.length >= MAX_DREAM_CLUSTERS) {
                    return clusters
                }
            }
        }
        return clusters
    }
}
