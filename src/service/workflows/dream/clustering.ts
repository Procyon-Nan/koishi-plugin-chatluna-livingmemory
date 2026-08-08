import type { ManualDreamVectorReader } from '../../../contracts/vector_index'
import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import { groupEntriesByLabel } from './hdbscan/labels'
import type { DreamHdbscanRunner } from './hdbscan/protocol'
import { DREAM_PARTITION_MAX_SIZE, partitionDreamEntries } from './partitioning'
import type { DreamCluster } from './types'

export class DreamClusterer {
    constructor(
        private readonly vectorReader: ManualDreamVectorReader,
        private readonly debug: (message: string) => void,
        private readonly enableTrace: boolean,
        private readonly hdbscan: DreamHdbscanRunner
    ) {}

    async buildClusters(
        presetId: string,
        entries: DreamMemoryEntryRecord[]
    ): Promise<DreamCluster[]> {
        if (entries.length < 2) {
            return []
        }

        const startedAt = Date.now()
        const partitions = partitionDreamEntries(entries)
        const clusters: DreamCluster[] = []
        const firstPassNoise: DreamMemoryEntryRecord[] = []
        this.trace(
            `memory dream partitioning completed: presetId=${presetId} ` +
                `entries=${entries.length} partitions=${partitions.length}`
        )

        for (let index = 0; index < partitions.length; index++) {
            const partition = partitions[index]
            const labels = await this.clusterEntries(presetId, partition)
            const groups = groupEntriesByLabel(partition, labels)
            const noise = groups.get(-1) ?? []
            firstPassNoise.push(...noise)

            let clusterCount = 0
            for (const [label, groupedEntries] of groups) {
                if (label === -1) {
                    continue
                }
                this.appendCluster(
                    clusters,
                    `hdbscan:primary:${index + 1}:${label}`,
                    groupedEntries
                )
                clusterCount++
            }

            this.trace(
                `memory dream partition clustered: presetId=${presetId} ` +
                    `partition=${index + 1}/${partitions.length} ` +
                    `entries=${partition.length} clusters=${clusterCount} ` +
                    `noise=${noise.length}`
            )
        }

        await this.appendNoiseClusters(presetId, firstPassNoise, clusters)
        this.trace(
            `memory dream clustering completed: presetId=${presetId} ` +
                `entries=${entries.length} clusters=${clusters.length} ` +
                `elapsedMs=${Date.now() - startedAt}`
        )
        return clusters
    }

    private async appendNoiseClusters(
        presetId: string,
        entries: DreamMemoryEntryRecord[],
        clusters: DreamCluster[]
    ) {
        this.trace(
            `memory dream global noise collected: presetId=${presetId} ` +
                `entries=${entries.length}`
        )
        if (entries.length === 0) {
            return
        }
        if (entries.length === 1) {
            this.appendCluster(clusters, 'hdbscan:final-noise', entries)
            return
        }

        this.trace(
            `memory dream global noise clustering started: ` +
                `presetId=${presetId} entries=${entries.length}`
        )
        const labels = await this.clusterEntries(presetId, entries)
        const groups = groupEntriesByLabel(entries, labels)
        for (const [label, groupedEntries] of groups) {
            if (label === -1) {
                continue
            }
            this.appendCluster(
                clusters,
                `hdbscan:noise:${label}`,
                groupedEntries
            )
        }
        const finalNoise = groups.get(-1)
        if (finalNoise !== undefined) {
            this.appendCluster(clusters, 'hdbscan:final-noise', finalNoise)
        }
        this.trace(
            `memory dream global noise clustering completed: ` +
                `presetId=${presetId} entries=${entries.length}`
        )
    }

    private async clusterEntries(
        presetId: string,
        entries: DreamMemoryEntryRecord[]
    ) {
        const startedAt = Date.now()
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

        const labels = await this.hdbscan.run(
            { entryCount: entries.length, dimension, vectors },
            this.enableTrace
        )
        this.traceHdbscanResult(
            presetId,
            entries.length,
            dimension,
            labels,
            startedAt
        )
        return labels
    }

    private traceHdbscanResult(
        presetId: string,
        entryCount: number,
        dimension: number,
        labels: Int32Array<ArrayBuffer>,
        startedAt: number
    ) {
        if (!this.enableTrace) {
            return
        }
        const clusterLabels = new Set<number>()
        let noiseCount = 0
        for (const label of labels) {
            if (label === -1) {
                noiseCount++
            } else {
                clusterLabels.add(label)
            }
        }
        this.debug(
            `memory dream hdbscan completed: presetId=${presetId} ` +
                `entries=${entryCount} dimension=${dimension} ` +
                `mstEdges=${entryCount - 1} ` +
                `clusters=${clusterLabels.size} noise=${noiseCount} ` +
                `elapsedMs=${Date.now() - startedAt}`
        )
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

    private trace(message: string) {
        if (this.enableTrace) {
            this.debug(message)
        }
    }
}
