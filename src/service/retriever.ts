import { Context } from 'koishi'
import type {
    LivingMemoryConfig,
    RecallRepository,
    RetrievedMemoryItem
} from '../types'

const isModelConfigured = (model: string) => {
    return model.length > 0 && model !== '无'
}

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
        const entries =
            await this.recallRepository.listEntriesByPreset(presetId)
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
                const haystack =
                    `${entry.content}\n${entry.keywords.join(' ')}`.toLowerCase()
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
            return []
        }

        const entries =
            await this.recallRepository.listEntriesByPreset(presetId)
        if (entries.length === 0) {
            return []
        }

        const queryVector = await embeddings.value.embedQuery(input)
        const docs = await embeddings.value.embedDocuments(
            entries.map((entry) => entry.content)
        )

        const embeddingResults = entries
            .map((entry, index) => ({
                id: entry.id,
                content: entry.content,
                score: this.cosineSimilarity(queryVector, docs[index] ?? [])
            }))
            .sort((left, right) => right.score - left.score)

        const candidateCount = Math.min(embeddingResults.length, limit * 3)
        const candidates = embeddingResults.slice(0, candidateCount)

        if (
            !isModelConfigured(this.config.rerankModel) ||
            candidates.length === 0
        ) {
            return candidates.slice(0, limit)
        }

        const reranker = await this.ctx.chatluna.createReranker(
            this.config.rerankModel
        )
        if (reranker?.value == null) {
            return candidates.slice(0, limit)
        }

        const rerankResults = await reranker.value.rerank(
            candidates.map((c) => c.content),
            input,
            { topN: limit }
        )

        return rerankResults.map((result) => ({
            id: candidates[result.index].id,
            content: candidates[result.index].content,
            score: result.relevanceScore
        }))
    }

    private cosineSimilarity(left: number[], right: number[]) {
        if (
            left.length === 0 ||
            right.length === 0 ||
            left.length !== right.length
        ) {
            return 0
        }

        let dot = 0
        let leftNorm = 0
        let rightNorm = 0

        for (let index = 0; index < left.length; index++) {
            dot += left[index] * right[index]
            leftNorm += left[index] * left[index]
            rightNorm += right[index] * right[index]
        }

        if (leftNorm === 0 || rightNorm === 0) {
            return 0
        }

        return dot / Math.sqrt(leftNorm * rightNorm)
    }
}
