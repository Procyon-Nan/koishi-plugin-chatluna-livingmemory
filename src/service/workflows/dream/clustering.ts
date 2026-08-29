import type { ManualDreamVectorReader } from '../../../contracts/vector_index'
import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import { groupEntriesByLabel } from './hdbscan/labels'
import type { DreamWorkerRunner } from './worker/protocol'
import { DREAM_PARTITION_MAX_SIZE } from './partitioning'
import type { DreamCluster, DreamStage } from './types'
import type { LivingMemoryLogger } from '../../logging/logger'

// 密度聚类的簇规模由数据几何决定，无法约束单次送入 LLM 的记忆数量。
// 超过该上限的簇按关键词共现做平衡切分，与增量 Dream 的
// INCREMENTAL_DREAM_TOP_K = 30 保持同一量级。
const DREAM_CLUSTER_UNIT_MAX_SIZE = 30

const toClusterSizeFields = (
    clusters: [number, DreamMemoryEntryRecord[]][]
) => {
    return Object.fromEntries(
        clusters.map(([, entries], index) => [
            `clusters-${index + 1}`,
            entries.length
        ])
    )
}

export class DreamClusterer {
    constructor(
        private readonly vectorReader: ManualDreamVectorReader,
        private readonly worker: DreamWorkerRunner
    ) {}

    async buildClusters(
        presetId: string,
        stage: DreamStage,
        entries: DreamMemoryEntryRecord[],
        logger?: LivingMemoryLogger
    ): Promise<DreamCluster[]> {
        if (entries.length < 2) {
            return []
        }

        const partitions = await this.worker.partition(entries)
        const clusters: DreamCluster[] = []
        const firstPassNoise: DreamMemoryEntryRecord[] = []
        logger?.diagnostic('dream.clustering.round.started', {
            stage,
            round: 'primary',
            batches: partitions.length
        })

        for (let index = 0; index < partitions.length; index++) {
            const partition = partitions[index]
            const result = await this.clusterEntries(presetId, partition)
            firstPassNoise.push(...result.noise)

            for (const [label, groupedEntries] of result.clusters) {
                this.appendCluster(
                    clusters,
                    `hdbscan:primary:${index + 1}:${label}`,
                    groupedEntries
                )
            }

            logger?.diagnostic('dream.clustering.batch.completed', {
                stage,
                round: 'primary',
                batch: index + 1,
                ...toClusterSizeFields(result.clusters),
                noise: result.noise.length
            })
        }

        logger?.diagnostic('dream.clustering.round.completed', {
            stage,
            round: 'primary',
            totalNoise: firstPassNoise.length
        })

        await this.appendNoiseClusters(
            presetId,
            stage,
            firstPassNoise,
            clusters,
            logger
        )
        return this.splitOversizedClusters(clusters)
    }

    private async splitOversizedClusters(
        clusters: DreamCluster[]
    ): Promise<DreamCluster[]> {
        const result: DreamCluster[] = []
        for (const cluster of clusters) {
            if (cluster.entries.length <= DREAM_CLUSTER_UNIT_MAX_SIZE) {
                result.push(cluster)
                continue
            }
            const chunks = await this.worker.partition(
                cluster.entries,
                DREAM_CLUSTER_UNIT_MAX_SIZE
            )
            chunks.forEach((entries, index) => {
                result.push({
                    id: `${cluster.id}:chunk-${index + 1}`,
                    reason: `${cluster.reason}:chunk-${index + 1}`,
                    entries
                })
            })
        }
        return result
    }

    private async appendNoiseClusters(
        presetId: string,
        stage: DreamStage,
        entries: DreamMemoryEntryRecord[],
        clusters: DreamCluster[],
        logger?: LivingMemoryLogger
    ) {
        const batches = entries.length < 2 ? 0 : 1
        logger?.diagnostic('dream.clustering.round.started', {
            stage,
            round: 'global-noise',
            batches
        })
        if (entries.length < 2) {
            if (entries.length === 1) {
                this.appendCluster(clusters, 'hdbscan:final-noise', entries)
            }
            logger?.diagnostic('dream.clustering.round.completed', {
                stage,
                round: 'global-noise',
                totalNoise: entries.length
            })
            return
        }

        const result = await this.clusterEntries(presetId, entries)
        for (const [label, groupedEntries] of result.clusters) {
            this.appendCluster(
                clusters,
                `hdbscan:noise:${label}`,
                groupedEntries
            )
        }
        if (result.noise.length > 0) {
            this.appendCluster(clusters, 'hdbscan:final-noise', result.noise)
        }
        logger?.diagnostic('dream.clustering.batch.completed', {
            stage,
            round: 'global-noise',
            batch: 1,
            ...toClusterSizeFields(result.clusters),
            noise: result.noise.length
        })
        logger?.diagnostic('dream.clustering.round.completed', {
            stage,
            round: 'global-noise',
            totalNoise: result.noise.length
        })
    }

    private async clusterEntries(
        presetId: string,
        entries: DreamMemoryEntryRecord[]
    ) {
        const firstBatch = entries.slice(0, DREAM_PARTITION_MAX_SIZE)
        const firstVectors = await this.vectorReader.readVectors(
            presetId,
            firstBatch.map((entry) => entry.id)
        )
        const dimension = firstVectors.get(firstBatch[0].id)!.length
        const vectors = new Float32Array(entries.length * dimension)
        this.writeVectors(vectors, dimension, 0, firstBatch, firstVectors)

        for (
            let offset = DREAM_PARTITION_MAX_SIZE;
            offset < entries.length;
            offset += DREAM_PARTITION_MAX_SIZE
        ) {
            const batch = entries.slice(
                offset,
                offset + DREAM_PARTITION_MAX_SIZE
            )
            const vectorById = await this.vectorReader.readVectors(
                presetId,
                batch.map((entry) => entry.id)
            )
            this.writeVectors(vectors, dimension, offset, batch, vectorById)
        }

        const labels = await this.worker.runHdbscan({
            entryCount: entries.length,
            dimension,
            vectors
        })
        const groups = groupEntriesByLabel(entries, labels)
        return {
            clusters: [...groups].filter(([label]) => label !== -1),
            noise: groups.get(-1) ?? []
        }
    }

    private writeVectors(
        matrix: Float32Array<ArrayBuffer>,
        dimension: number,
        offset: number,
        entries: DreamMemoryEntryRecord[],
        vectorById: ReadonlyMap<string, Float32Array<ArrayBuffer>>
    ) {
        entries.forEach((entry, index) => {
            matrix.set(vectorById.get(entry.id)!, (offset + index) * dimension)
        })
    }

    private appendCluster(
        clusters: DreamCluster[],
        reason: string,
        entries: DreamMemoryEntryRecord[]
    ) {
        clusters.push({
            id: `cluster-${clusters.length + 1}`,
            reason,
            entries
        })
    }
}
