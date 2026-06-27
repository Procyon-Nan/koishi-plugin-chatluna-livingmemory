import { Context } from 'koishi'
import type {
    LivingMemoryConfig,
    RecallRepository,
    RetrievedMemoryItem
} from '../types'
import { cosineSimilarity, isModelConfigured } from './shared/utils'
import {
    ensureEntryEmbeddings,
    toMemoryRetrievalText
} from './shared/embeddings'

export class LivingMemoryRetriever {
    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig,
        private readonly recallRepository: RecallRepository
    ) {}

    async retrieve(presetId: string, input: string, limit: number) {
        return await this.retrieveByEmbedding(presetId, input, limit)
    }

    private async retrieveByEmbedding(
        presetId: string,
        input: string,
        limit: number
    ): Promise<RetrievedMemoryItem[]> {
        if (!isModelConfigured(this.config.embeddingModel)) {
            throw new Error('memory retrieve embedding model is not configured')
        }

        const embeddings = await this.ctx.chatluna.createEmbeddings(
            this.config.embeddingModel
        )
        if (embeddings?.value == null) {
            throw new Error(
                `memory retrieve embedding unavailable: model=${this.config.embeddingModel}`
            )
        }

        const entries = await this.listActiveEntries(presetId)
        if (entries.length === 0) {
            return []
        }

        const queryVector = await embeddings.value.embedQuery(input)
        if (queryVector.length === 0) {
            throw new Error('memory retrieve embedding query vector is empty')
        }

        const vectorById = await ensureEntryEmbeddings(
            embeddings.value,
            this.recallRepository,
            this.config.embeddingModel,
            entries,
            {
                logger: this.ctx.logger('chatluna-livingmemory'),
                debug: (message) => {
                    if (this.config.debug) {
                        this.ctx.logger('chatluna-livingmemory').info(message)
                    }
                },
                // 查询向量由当前模型现算，其维度即当前模型的输出维度，
                // 以此让维度不一致的旧缓存向量失效重算，避免 cosine 静默归零。
                expectedDimension: queryVector.length
            }
        )

        const embeddingResults = entries
            .map((entry) => {
                const vector = vectorById.get(entry.id)
                if (vector == null || vector.length !== queryVector.length) {
                    throw new Error(
                        `memory retrieve entry embedding invalid: id=${entry.id}`
                    )
                }

                return {
                    id: entry.id,
                    content: entry.content,
                    retrievalText: toMemoryRetrievalText(entry),
                    score: cosineSimilarity(queryVector, vector)
                }
            })
            .sort((left, right) => right.score - left.score)

        const candidateCount = Math.min(embeddingResults.length, limit * 3)
        const candidates = embeddingResults.slice(0, candidateCount)

        if (candidates.length === 0) {
            return []
        }

        if (!isModelConfigured(this.config.rerankModel)) {
            throw new Error('memory retrieve rerank model is not configured')
        }

        const reranker = await this.ctx.chatluna.createReranker(
            this.config.rerankModel
        )
        if (reranker?.value == null) {
            throw new Error(
                `memory retrieve reranker unavailable: model=${this.config.rerankModel}`
            )
        }

        const rerankResults = await reranker.value.rerank(
            candidates.map((c) => c.retrievalText),
            input,
            { topN: limit }
        )

        return rerankResults.map((result) => {
            const candidate = candidates[result.index]
            if (candidate == null) {
                throw new Error(
                    [
                        'memory rerank index out of bounds:',
                        `index=${result.index}`,
                        `candidateCount=${candidates.length}`
                    ].join(' ')
                )
            }
            return {
                id: candidate.id,
                content: candidate.content,
                score: result.relevanceScore
            }
        })
    }

    private async listActiveEntries(presetId: string) {
        const entries =
            await this.recallRepository.listEntriesByPreset(presetId)
        return entries.filter((entry) => entry.status === 'active')
    }
}
