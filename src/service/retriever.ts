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

        return this.ctx.chatluna.withUsageSource(
            'chatluna-livingmemory',
            async () => {
                const embeddings = await this.ctx.chatluna.createEmbeddings(
                    this.config.embeddingModel
                )
                if (embeddings?.value == null) {
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
                            }
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

                const candidateCount = Math.min(
                    embeddingResults.length,
                    limit * 3
                )
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

                return rerankResults.map((result) => ({
                    id: candidates[result.index].id,
                    content: candidates[result.index].content,
                    score: result.relevanceScore
                }))
            }
        )
    }

    private async listActiveEntries(presetId: string) {
        const entries =
            await this.recallRepository.listEntriesByPreset(presetId)
        return entries.filter((entry) => entry.status === 'active')
    }
}
