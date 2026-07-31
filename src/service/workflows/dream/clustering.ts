import { Context } from 'koishi'
import type { MemoryEntryRecord } from '../../../contracts/memory'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import { HDBSCAN } from 'hdbscan-ts'
import {
    type EmbeddingRepositoryLike,
    ensureEntryEmbeddings
} from '../../shared/embeddings'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import type { DreamCluster } from './types'
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

export class DreamClusterer {
    constructor(
        private readonly ctx: Context,
        private readonly config: DreamClustererConfig,
        private readonly repository: EmbeddingRepositoryLike,
        private readonly debug: (message: string) => void
    ) {}

    async buildClusters(entries: MemoryEntryRecord[]): Promise<DreamCluster[]> {
        if (entries.length < 2) {
            return []
        }

        const vectorById = await this.ensureVectors(entries)
        if (vectorById == null) {
            return []
        }

        // 只保留有有效向量的条目，保持向量与条目的索引对齐
        const indexed = entries
            .map((entry) => ({
                entry,
                vector: vectorById.get(entry.id)
            }))
            .filter(
                (
                    item
                ): item is { entry: MemoryEntryRecord; vector: number[] } =>
                    Array.isArray(item.vector) && item.vector.length > 0
            )
        if (indexed.length < 2) {
            this.debug(
                `memory dream hdbscan: insufficient valid vectors (${indexed.length}/${entries.length}), clustering skipped`
            )
            return []
        }

        const normalized = indexed.map((item) => l2Normalize(item.vector))

        const hdbscan = new HDBSCAN({
            minClusterSize: HDBSCAN_MIN_CLUSTER_SIZE,
            minSamples: HDBSCAN_MIN_SAMPLES
        })
        const labels = hdbscan.fit(normalized)
        const probabilities = hdbscan.probabilities_

        const distinctClusters = new Set(labels.filter((label) => label !== -1))
        const noiseCount = labels.filter((label) => label === -1).length
        this.debug(
            [
                `memory dream hdbscan: entries=${indexed.length}`,
                `clusters=${distinctClusters.size}`,
                `noise=${noiseCount}`
            ].join(' ')
        )

        const groups = this.groupByLabel(indexed, labels, probabilities)
        if (groups.length === 0) {
            this.debug(
                'memory dream hdbscan: all points classified as noise, no clusters'
            )
            return []
        }

        return this.toDreamClusters(groups)
    }

    private async ensureVectors(
        entries: MemoryEntryRecord[]
    ): Promise<Map<string, number[]> | null> {
        if (!isModelConfigured(this.config.embeddingModel)) {
            this.debug(
                'memory dream clustering skipped: embedding model not configured'
            )
            return null
        }

        try {
            const embeddings = await this.ctx.chatluna.createEmbeddings(
                this.config.embeddingModel
            )
            if (embeddings?.value == null) {
                this.debug(
                    'memory dream clustering skipped: embedding model unavailable'
                )
                return null
            }

            // 维度探测：用一条代表性条目现算一次以探测当前模型输出维度，
            // 使维度不一致的旧缓存向量失效重算（详见 ensureEntryEmbeddings）。
            let expectedDimension = 0
            const probeEntry = entries[0]
            if (probeEntry != null) {
                try {
                    const probeVector = await embeddings.value.embedQuery(
                        probeEntry.content
                    )
                    expectedDimension = probeVector.length
                } catch (error) {
                    this.debug(
                        `memory dream embedding dimension probe failed: ${summarizeError(error)}`
                    )
                }
            }

            return await ensureEntryEmbeddings(
                embeddings.value,
                this.repository,
                this.config.embeddingModel,
                entries,
                {
                    logger: this.ctx.logger('chatluna-livingmemory'),
                    debug: (message) => this.debug(message),
                    expectedDimension
                }
            )
        } catch (error) {
            this.debug(
                [
                    'memory dream clustering failed: embedding error',
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
            return null
        }
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
