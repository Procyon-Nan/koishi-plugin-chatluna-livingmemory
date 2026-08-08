import { Context, type Logger } from 'koishi'
import type {
    LivingMemoryConfig,
    RecallRepository,
    RetrievedMemoryItem
} from '../../../contracts/workflows'
import type { MemoryVectorSearch } from '../../../contracts/vector_index'
import { isModelConfigured } from '../../shared/utils'
import { toMemoryRetrievalText } from '../../shared/embeddings'
import { loadIndexedMemoryEntries } from './indexed_entries'

type LivingMemoryRetrieverConfig = Pick<
    LivingMemoryConfig,
    'debug' | 'rerankModel'
>

export class LivingMemoryRetriever {
    private readonly logger: Logger

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryRetrieverConfig,
        private readonly repository: RecallRepository,
        private readonly vectorSearch: MemoryVectorSearch
    ) {
        this.logger = ctx.logger('chatluna-livingmemory')
    }

    async retrieve(
        presetId: string,
        input: string,
        limit: number
    ): Promise<RetrievedMemoryItem[]> {
        let candidateCount = limit
        if (isModelConfigured(this.config.rerankModel)) {
            candidateCount = limit * 3
        }
        const hits = await this.vectorSearch.searchSemantic({
            presetId,
            searchTexts: [input],
            status: 'active',
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
            retrievalText: toMemoryRetrievalText(entry),
            score: hits[index].cosineScore
        }))
        if (candidates.length === 0) {
            return []
        }

        if (!isModelConfigured(this.config.rerankModel)) {
            this.debugLog(
                'memory recall rerank model not configured, fallback to embedding-only top-K'
            )
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
            this.logger.warn(error)
            return this.embeddingOnlyTopK(candidates, limit)
        }
    }

    private debugLog(message: string) {
        if (this.config.debug) {
            this.logger.info(message)
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
