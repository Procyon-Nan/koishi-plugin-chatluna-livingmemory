import { Context } from 'koishi'
import type {
    LivingMemoryConfig,
    RecallRepository,
    RetrievedMemoryItem
} from '../types'
import {
    cosineSimilarity,
    isModelConfigured,
    summarizeError
} from './shared/utils'
import {
    ensureEntryEmbeddings,
    toMemoryRetrievalText
} from './shared/embeddings'

const defaultKeywords = (content: string) => {
    return Array.from(
        new Set(
            content
                .toLowerCase()
                .split(/[^\p{L}\p{N}_]+/u)
                .map((part) => part.trim())
                .filter((part) => part.length >= 2)
        )
    ).slice(0, 12)
}

export class LivingMemoryRetriever {
    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig,
        private readonly recallRepository: RecallRepository
    ) {}

    async retrieve(presetId: string, input: string, limit: number) {
        if (this.config.recallStrategy === 'embedding-rerank') {
            const embeddingResult = await this.retrieveByEmbedding(
                presetId,
                input,
                limit
            )

            if (
                embeddingResult.length > 0 ||
                !this.config.enableKeywordFallback
            ) {
                return embeddingResult
            }
        }

        return await this.retrieveByKeyword(presetId, input, limit)
    }

    private async retrieveByKeyword(
        presetId: string,
        input: string,
        limit: number
    ): Promise<RetrievedMemoryItem[]> {
        const entries = await this.listActiveEntries(presetId)
        if (entries.length === 0) {
            return []
        }

        const terms = defaultKeywords(input)
        if (terms.length === 0) {
            return entries
                .slice(-limit)
                .reverse()
                .map((entry, index) => ({
                    id: entry.id,
                    content: entry.content,
                    score: Math.max(0, limit - index)
                }))
        }

        return entries
            .map((entry) => {
                const haystack = toMemoryRetrievalText(entry).toLowerCase()
                const score = terms.reduce((accumulator, term) => {
                    return accumulator + (haystack.includes(term) ? 1 : 0)
                }, 0)

                return {
                    id: entry.id,
                    content: entry.content,
                    score,
                    createdAt: entry.createdAt
                }
            })
            .filter((entry) => entry.score > 0)
            .sort((left, right) => {
                if (right.score !== left.score) {
                    return right.score - left.score
                }
                return +right.createdAt - +left.createdAt
            })
            .slice(0, limit)
            .map(({ createdAt: _createdAt, ...entry }) => entry)
    }

    private async retrieveByEmbedding(
        presetId: string,
        input: string,
        limit: number
    ): Promise<RetrievedMemoryItem[]> {
        if (!isModelConfigured(this.config.embeddingModel)) {
            return []
        }

        const embeddings = await this.ctx.chatluna.createEmbeddings(
            this.config.embeddingModel
        )
        if (embeddings?.value == null) {
            // embedding 模型已配置但未能创建可用实例，返回空结果。
            // 若开启关键词回退，retrieve 会据此降级到关键词检索。
            if (this.config.debug) {
                this.ctx
                    .logger('chatluna-livingmemory')
                    .info(
                        [
                            'memory retrieve embedding unavailable:',
                            `model=${this.config.embeddingModel}`
                        ].join(' ')
                    )
            }
            return []
        }

        const entries = await this.listActiveEntries(presetId)
        if (entries.length === 0) {
            return []
        }

        const queryVector = await embeddings.value.embedQuery(input)

        let vectorById: Map<string, number[]>
        try {
            vectorById = await ensureEntryEmbeddings(
                embeddings.value,
                this.recallRepository,
                this.config.embeddingModel,
                entries,
                {
                    logger: this.ctx.logger('chatluna-livingmemory'),
                    debug: (message) => {
                        if (this.config.debug) {
                            this.ctx
                                .logger('chatluna-livingmemory')
                                .info(message)
                        }
                    },
                    // 查询向量由当前模型现算，其维度即当前模型的输出维度，
                    // 以此让维度不一致的旧缓存向量失效重算，避免 cosine 静默归零。
                    expectedDimension: queryVector.length
                }
            )
        } catch (error) {
            this.ctx
                .logger('chatluna-livingmemory')
                .warn(
                    `memory retrieve embedding failed: ${summarizeError(error)}`
                )
            return []
        }

        const embeddingResults = entries
            .map((entry) => {
                const vector = vectorById.get(entry.id) ?? []
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

        if (
            !isModelConfigured(this.config.rerankModel) ||
            candidates.length === 0
        ) {
            return candidates.slice(0, limit).map((candidate) => ({
                id: candidate.id,
                content: candidate.content,
                score: candidate.score
            }))
        }

        const reranker = await this.ctx.chatluna.createReranker(
            this.config.rerankModel
        )
        if (reranker?.value == null) {
            return candidates.slice(0, limit).map((candidate) => ({
                id: candidate.id,
                content: candidate.content,
                score: candidate.score
            }))
        }

        const rerankResults = await reranker.value.rerank(
            candidates.map((c) => c.retrievalText),
            input,
            { topN: limit }
        )

        // rerank 服务返回的 index 为外部输入，直接作为下标可能越界
        // （协议差异、索引基准不一致等），会取到 undefined 并抛错导致整轮
        // 召回失败。对每条结果做边界校验：越界则跳过并记录日志，合法则回填。
        return rerankResults
            .map((result) => {
                const candidate = candidates[result.index]
                if (candidate == null) {
                    if (this.config.debug) {
                        this.ctx
                            .logger('chatluna-livingmemory')
                            .info(
                                [
                                    'memory rerank index out of bounds:',
                                    `index=${result.index}`,
                                    `candidateCount=${candidates.length}`
                                ].join(' ')
                            )
                    }
                    return null
                }
                return {
                    id: candidate.id,
                    content: candidate.content,
                    score: result.relevanceScore
                }
            })
            .filter((item): item is NonNullable<typeof item> => item != null)
    }

    private async listActiveEntries(presetId: string) {
        const entries =
            await this.recallRepository.listEntriesByPreset(presetId)
        return entries.filter((entry) => entry.status === 'active')
    }
}
