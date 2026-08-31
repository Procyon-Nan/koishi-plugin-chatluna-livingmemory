import { Context } from 'koishi'
import type {
    LivingMemoryConfig,
    RecallRepository,
    RetrievedMemoryItem
} from '../../../contracts/workflows'
import type { MemoryVectorSearch } from '../../../contracts/vector_index'
import { isModelConfigured } from '../../shared/utils'
import { loadIndexedMemoryEntries } from './indexed_entries'
import type { LivingMemoryLogger } from '../../logging/logger'

type LivingMemoryRetrieverConfig = Pick<LivingMemoryConfig, 'rerankModel'>

/** 配置了 Reranker 时，语义检索候选量按 topK 扩大该倍数后再重排。 */
const RERANK_CANDIDATE_MULTIPLIER = 3

export class LivingMemoryRetriever {
    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryRetrieverConfig,
        private readonly repository: RecallRepository,
        private readonly vectorSearch: MemoryVectorSearch,
        private readonly logger: LivingMemoryLogger
    ) {}

    async retrieve(
        presetId: string,
        input: string,
        limit: number,
        logger: LivingMemoryLogger = this.logger
    ): Promise<RetrievedMemoryItem[]> {
        const hasReranker = isModelConfigured(this.config.rerankModel)
        const candidateCount = hasReranker
            ? limit * RERANK_CANDIDATE_MULTIPLIER
            : limit
        const hits = await this.vectorSearch.searchSemantic({
            presetId,
            searchTexts: [input],
            memoryTypes: null,
            maxCandidates: candidateCount
        })
        const entries = await loadIndexedMemoryEntries(
            this.repository,
            presetId,
            hits.map((hit) => hit.memoryId)
        )
        const candidates = entries.map((entry, index) => ({
            id: entry.id,
            content: entry.content,
            retrievalText: entry.content,
            score: hits[index].cosineScore
        }))
        if (candidates.length === 0) {
            return []
        }

        if (!hasReranker) {
            logger.diagnostic('recall.rerank.skipped', {
                workflow: 'recall',
                reason: 'model-not-configured'
            })
            return this.embeddingOnlyTopK(candidates, limit)
        }

        try {
            const reranker = await this.ctx.chatluna.createReranker(
                this.config.rerankModel
            )
            if (reranker?.value == null) {
                throw new Error(
                    `memory retrieve reranker unavailable: model=${this.config.rerankModel}`
                )
            }

            const rerankResults = await reranker.value.rerank(
                candidates.map((candidate) => candidate.retrievalText),
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
        } catch (error) {
            logger.warn(
                'recall.rerank.failed',
                { workflow: 'recall', operation: 'rerank' },
                error
            )
            return this.embeddingOnlyTopK(candidates, limit)
        }
    }

    private embeddingOnlyTopK(
        results: { id: string; content: string; score: number }[],
        limit: number
    ): RetrievedMemoryItem[] {
        return results
            .slice(0, limit)
            .map(({ id, content, score }) => ({ id, content, score }))
    }
}
