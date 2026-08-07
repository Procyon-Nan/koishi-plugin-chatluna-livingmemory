import type { Context } from 'koishi'
import type { MemoryEntryRecord } from '../../../contracts/memory'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    type EmbeddingRepositoryLike,
    type EmbeddingsLike,
    ensureEntryEmbeddings
} from '../../shared/embeddings'
import {
    cosineSimilarity,
    isModelConfigured,
    summarizeError
} from '../../shared/utils'

export const INCREMENTAL_DREAM_TOP_K = 30

type IncrementalRetrievalConfig = Pick<LivingMemoryConfig, 'embeddingModel'>

export class IncrementalDreamRetriever {
    private readonly vectorCache = new Map<
        string,
        { content: string; vector: number[] }
    >()

    private constructor(
        private readonly embeddings: EmbeddingsLike,
        private readonly modelId: string,
        private readonly expectedDimension: number,
        private readonly repository: EmbeddingRepositoryLike,
        private readonly debug: (message: string) => void
    ) {}

    static async create(
        ctx: Context,
        config: IncrementalRetrievalConfig,
        repository: EmbeddingRepositoryLike,
        sampleContent: string,
        debug: (message: string) => void
    ) {
        if (!isModelConfigured(config.embeddingModel)) {
            throw new Error(
                'incremental dream embedding model is not configured'
            )
        }

        let embeddings
        try {
            embeddings = await ctx.chatluna.createEmbeddings(
                config.embeddingModel
            )
        } catch (error) {
            throw new Error(
                `incremental dream embedding model creation failed: ${summarizeError(error)}`
            )
        }
        if (embeddings.value === undefined) {
            throw new Error('incremental dream embedding model is unavailable')
        }

        let probe: number[]
        try {
            probe = await embeddings.value.embedQuery(sampleContent)
        } catch (error) {
            throw new Error(
                `incremental dream embedding probe failed: ${summarizeError(error)}`
            )
        }
        validateVectorValues(probe, 'probe')

        return new IncrementalDreamRetriever(
            embeddings.value,
            config.embeddingModel,
            probe.length,
            repository,
            debug
        )
    }

    async retrieve(
        seed: MemoryEntryRecord,
        candidates: MemoryEntryRecord[]
    ): Promise<MemoryEntryRecord[]> {
        if (candidates.length === 0) {
            return []
        }

        await this.cacheEntryVectors([seed, ...candidates])
        const seedVector = this.vectorCache.get(seed.id)!.vector

        return candidates
            .map((entry) => {
                const vector = this.vectorCache.get(entry.id)!.vector
                return {
                    entry,
                    score: cosineSimilarity(seedVector, vector)
                }
            })
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    left.entry.id.localeCompare(right.entry.id)
            )
            .slice(0, INCREMENTAL_DREAM_TOP_K)
            .map((item) => item.entry)
    }

    private async cacheEntryVectors(entries: MemoryEntryRecord[]) {
        const staleEntries = entries.filter(
            (entry) => this.vectorCache.get(entry.id)?.content !== entry.content
        )
        if (staleEntries.length === 0) {
            return
        }

        let vectors: Map<string, number[]>
        try {
            vectors = await ensureEntryEmbeddings(
                this.embeddings,
                this.repository,
                this.modelId,
                staleEntries,
                {
                    expectedDimension: this.expectedDimension,
                    persistenceFailure: 'throw',
                    debug: this.debug
                }
            )
        } catch (error) {
            throw new Error(
                `incremental dream embedding generation failed: ${summarizeError(error)}`
            )
        }

        for (const entry of staleEntries) {
            this.vectorCache.set(entry.id, {
                content: entry.content,
                vector: vectors.get(entry.id)!
            })
        }
    }
}

function validateVectorValues(
    vector: unknown,
    id: string
): asserts vector is number[] {
    if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.some((value) => !Number.isFinite(value))
    ) {
        throw new Error(`incremental dream embedding invalid: id=${id}`)
    }
    let normSq = 0
    for (const value of vector) {
        normSq += value * value
    }
    if (normSq === 0) {
        throw new Error(`incremental dream embedding is zero vector: id=${id}`)
    }
}
