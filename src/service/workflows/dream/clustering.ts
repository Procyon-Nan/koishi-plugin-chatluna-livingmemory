import { Context } from 'koishi'
import type { MemoryEntryRecord } from '../../../contracts/memory'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    type EmbeddingRepositoryLike,
    type EmbeddingsLike,
    ensureEntryEmbeddings
} from '../../shared/embeddings'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import { type DreamHdbscanRunner, runDreamHdbscan } from './hdbscan'
import { buildManualDreamClustersFromVectors } from './manual_clustering'
import { partitionDreamEntries } from './partitioning'

type DreamClustererConfig = Pick<LivingMemoryConfig, 'embeddingModel'>

interface EmbeddingContext {
    embeddings: EmbeddingsLike
    expectedDimension: number
}

export class DreamClusterer {
    constructor(
        private readonly ctx: Context,
        private readonly config: DreamClustererConfig,
        private readonly repository: EmbeddingRepositoryLike,
        private readonly debug: (message: string) => void,
        private readonly runHdbscan: DreamHdbscanRunner = runDreamHdbscan
    ) {}

    async buildClusters(entries: MemoryEntryRecord[]) {
        if (entries.length < 2) {
            return []
        }
        const embeddingContext = await this.createEmbeddingContext(entries)
        const partitions = partitionDreamEntries(entries)
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
            vectorById,
            this.runHdbscan
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
        if (embeddings.value === undefined) {
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
            probeVector.some((value) => !Number.isFinite(value)) ||
            probeVector.every((value) => value === 0)
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
    ) {
        let vectors: Map<string, number[]>
        try {
            vectors = await ensureEntryEmbeddings(
                context.embeddings,
                this.repository,
                this.config.embeddingModel,
                entries,
                {
                    debug: (message) => this.debug(message),
                    expectedDimension: context.expectedDimension,
                    persistenceFailure: 'throw'
                }
            )
        } catch (error) {
            throw new Error(
                `dream embedding generation failed: ${summarizeError(error)}`
            )
        }

        return vectors
    }
}
