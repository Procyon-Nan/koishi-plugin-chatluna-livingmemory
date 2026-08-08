import type { ManualDreamVectorReader } from '../../../contracts/vector_index'
import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import {
    type DreamHdbscanRunner,
    groupEntriesByLabel,
    readNormalizedVectors,
    runDreamHdbscan
} from './hdbscan'
import { DREAM_PARTITION_MAX_SIZE, partitionDreamEntries } from './partitioning'
import type { DreamCluster } from './types'

export class DreamClusterer {
    constructor(
        private readonly vectorReader: ManualDreamVectorReader,
        private readonly debug: (message: string) => void,
        private readonly enableTrace: boolean,
        private readonly runHdbscan: DreamHdbscanRunner = runDreamHdbscan
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
        const vectors: number[][] = []
        for (
            let offset = 0;
            offset < entries.length;
            offset += DREAM_PARTITION_MAX_SIZE
        ) {
            const batch = entries.slice(
                offset,
                offset + DREAM_PARTITION_MAX_SIZE
            )
            vectors.push(...(await this.readNormalized(presetId, batch)))
        }
        const result = this.runHdbscan(vectors)
        const groups = groupEntriesByLabel(entries, result.labels)
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
        const vectors = await this.readNormalized(presetId, entries)
        return this.runHdbscan(vectors).labels
    }

    private async readNormalized(
        presetId: string,
        entries: DreamMemoryEntryRecord[]
    ) {
        const vectorById = await this.vectorReader.readVectors(
            presetId,
            entries.map((entry) => entry.id)
        )
        return readNormalizedVectors(entries, vectorById)
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
