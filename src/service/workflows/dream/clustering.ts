import type { ManualDreamVectorReader } from '../../../contracts/vector_index'
import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import { groupEntriesByLabel } from './hdbscan/labels'
import type {
    DreamHdbscanProgress,
    DreamHdbscanProgressHandler,
    DreamHdbscanRunner
} from './hdbscan/protocol'
import { DREAM_PARTITION_MAX_SIZE, partitionDreamEntries } from './partitioning'
import type { DreamCluster, DreamStage } from './types'

type DreamHdbscanPass =
    | {
          type: 'primary'
          partition: number
          partitionCount: number
      }
    | { type: 'global-noise' }

type LabeledEntries = [number, DreamMemoryEntryRecord[]]

const formatSizes = (sizes: number[]) => `[${sizes.join(',')}]`

const formatClusterSizes = (clusters: LabeledEntries[]) =>
    `[${clusters
        .map(([label, entries]) => `${label}:${entries.length}`)
        .join(',')}]`

const formatPass = (pass: DreamHdbscanPass) => {
    if (pass.type === 'global-noise') {
        return 'pass=global-noise'
    }
    return `pass=primary partition=${pass.partition}/${pass.partitionCount}`
}

export class DreamClusterer {
    constructor(
        private readonly vectorReader: ManualDreamVectorReader,
        private readonly debug: (message: string) => void,
        private readonly enableTrace: boolean,
        private readonly hdbscan: DreamHdbscanRunner
    ) {}

    async buildClusters(
        presetId: string,
        stage: DreamStage,
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
            () =>
                `memory dream clustering partitioned: presetId=${presetId} ` +
                `stage=${stage} entries=${entries.length} ` +
                `partitions=${partitions.length} ` +
                `partitionSizes=${formatSizes(
                    partitions.map((partition) => partition.length)
                )}`
        )

        for (let index = 0; index < partitions.length; index++) {
            const partition = partitions[index]
            const result = await this.clusterEntries(
                presetId,
                stage,
                {
                    type: 'primary',
                    partition: index + 1,
                    partitionCount: partitions.length
                },
                partition
            )
            firstPassNoise.push(...result.noise)

            for (const [label, groupedEntries] of result.clusters) {
                this.appendCluster(
                    clusters,
                    `hdbscan:primary:${index + 1}:${label}`,
                    groupedEntries
                )
            }

            this.trace(
                () =>
                    `memory dream clustering partition completed: ` +
                    `presetId=${presetId} ` +
                    `stage=${stage} ` +
                    `partition=${index + 1}/${partitions.length} ` +
                    `entries=${partition.length} ` +
                    `clusters=${result.clusters.length} ` +
                    `clusterSizes=${formatClusterSizes(result.clusters)} ` +
                    `noise=${result.noise.length} ` +
                    `dimension=${result.dimension} elapsedMs=${result.elapsedMs}`
            )
        }

        await this.appendNoiseClusters(
            presetId,
            stage,
            firstPassNoise,
            clusters
        )
        this.trace(
            () =>
                `memory dream clustering completed: presetId=${presetId} ` +
                `stage=${stage} entries=${entries.length} ` +
                `units=${clusters.length} ` +
                `elapsedMs=${Date.now() - startedAt}`
        )
        return clusters
    }

    private async appendNoiseClusters(
        presetId: string,
        stage: DreamStage,
        entries: DreamMemoryEntryRecord[],
        clusters: DreamCluster[]
    ) {
        if (entries.length < 2) {
            if (entries.length === 1) {
                this.appendCluster(clusters, 'hdbscan:final-noise', entries)
            }
            this.trace(
                () =>
                    `memory dream clustering global-noise completed: ` +
                    `presetId=${presetId} stage=${stage} ` +
                    `entries=${entries.length} hdbscan=skipped ` +
                    `clusters=0 clusterSizes=[] finalNoise=${entries.length}`
            )
            return
        }

        this.trace(
            () =>
                `memory dream clustering global-noise started: ` +
                `presetId=${presetId} stage=${stage} ` +
                `entries=${entries.length}`
        )
        const result = await this.clusterEntries(
            presetId,
            stage,
            { type: 'global-noise' },
            entries
        )
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
        this.trace(
            () =>
                `memory dream clustering global-noise completed: ` +
                `presetId=${presetId} stage=${stage} ` +
                `entries=${entries.length} ` +
                `clusters=${result.clusters.length} ` +
                `clusterSizes=${formatClusterSizes(result.clusters)} ` +
                `finalNoise=${result.noise.length} ` +
                `dimension=${result.dimension} elapsedMs=${result.elapsedMs}`
        )
    }

    private async clusterEntries(
        presetId: string,
        stage: DreamStage,
        pass: DreamHdbscanPass,
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

        let onProgress: DreamHdbscanProgressHandler | undefined
        if (this.enableTrace) {
            onProgress = (progress) =>
                this.traceHdbscanProgress(
                    presetId,
                    stage,
                    pass,
                    entries.length,
                    progress
                )
        }
        const labels = await this.hdbscan.run(
            { entryCount: entries.length, dimension, vectors },
            onProgress
        )
        const groups = groupEntriesByLabel(entries, labels)
        return {
            clusters: [...groups].filter(([label]) => label !== -1),
            noise: groups.get(-1) ?? [],
            dimension,
            elapsedMs: Date.now() - startedAt
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

    private traceHdbscanProgress(
        presetId: string,
        stage: DreamStage,
        pass: DreamHdbscanPass,
        entryCount: number,
        progress: DreamHdbscanProgress
    ) {
        const percent = Math.round((progress.completed / progress.total) * 100)
        this.debug(
            `memory dream clustering progress: presetId=${presetId} ` +
                `stage=${stage} ${formatPass(pass)} entries=${entryCount} ` +
                `phase=${progress.phase} completed=${progress.completed} ` +
                `total=${progress.total} percent=${percent} ` +
                `elapsedMs=${Math.round(progress.elapsedMs)}`
        )
    }

    private trace(buildMessage: () => string) {
        if (this.enableTrace) {
            this.debug(buildMessage())
        }
    }
}
