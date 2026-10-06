import type { Context } from 'koishi'
import type {
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    MemoryEntryType
} from '../../../contracts/memory'
import type { MemoryVectorSearch } from '../../../contracts/vector_index'
import type {
    LivingMemoryConfig,
    LivingMemorySearchProvider,
    RecallRepository
} from '../../../contracts/workflows'
import type { LivingMemoryLogger } from '../../logging/logger'
import { isModelConfigured } from '../../shared/utils'
import { loadIndexedMemoryEntries } from './indexed_entries'

type EmbeddingSearchEngineConfig = Pick<
    LivingMemoryConfig,
    'memorySearchToolMaxResults' | 'memorySearchMinSimilarity' | 'rerankModel'
>

/** 配置了 Reranker 时，混合检索候选量按结果上限扩大该倍数后再重排。 */
const RERANK_CANDIDATE_MULTIPLIER = 3

const resolveMemoryTypes = (
    input: LivingMemorySearchInput
): MemoryEntryType[] | null => {
    if (input.memoryTypes.includes('all')) {
        return null
    }
    return input.memoryTypes as MemoryEntryType[]
}

export class LivingMemoryEmbeddingSearchEngine implements LivingMemorySearchProvider {
    constructor(
        private readonly ctx: Context,
        private readonly config: EmbeddingSearchEngineConfig,
        private readonly repository: RecallRepository,
        private readonly vectorSearch: MemoryVectorSearch,
        private readonly logger: LivingMemoryLogger
    ) {}

    async searchMemories(
        presetId: string,
        input: LivingMemorySearchInput,
        conversationId?: string
    ): Promise<LivingMemorySearchResult[]> {
        const detailed = await this.searchMemoriesDetailed(
            presetId,
            input,
            conversationId
        )
        return detailed.map((entry) => ({
            id: entry.id,
            type: entry.type,
            content: entry.content,
            keywords: [...entry.keywords],
            summary: entry.summary,
            sentiment: entry.sentiment,
            importance: entry.importance,
            sourceLabel: entry.sourceLabel,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
        }))
    }

    async searchMemoriesDetailed(
        presetId: string,
        input: LivingMemorySearchInput,
        conversationId?: string
    ): Promise<LivingMemorySearchDetailedResult[]> {
        const limit = this.config.memorySearchToolMaxResults
        const hasReranker = isModelConfigured(this.config.rerankModel)
        const hits = await this.vectorSearch.searchHybrid({
            presetId,
            conversationId,
            searchTexts: input.searchTexts,
            keywords: input.searchKeywords ?? [],
            memoryTypes: resolveMemoryTypes(input),
            memoryStatus: input.memoryStatus ?? 'active',
            maxCandidates: hasReranker
                ? limit * RERANK_CANDIDATE_MULTIPLIER
                : limit,
            minSimilarity: this.config.memorySearchMinSimilarity
        })
        const entries = await loadIndexedMemoryEntries(
            this.repository,
            presetId,
            hits.map((hit) => hit.memoryId)
        )
        const results = entries.map((entry, index) => {
            const hit = hits[index]
            return {
                id: entry.id,
                type: entry.type,
                content: entry.content,
                keywords: [...entry.keywords],
                summary: entry.summary,
                sentiment: entry.sentiment,
                importance: entry.importance,
                sourceLabel: entry.sourceLabel,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
                cosineScore: hit.cosineScore,
                keywordMatchCount: hit.keywordMatchCount,
                boostedScore: hit.boostedScore,
                rerankScore: null
            }
        })
        if (!hasReranker || results.length === 0) {
            return results
        }

        try {
            return await this.rerank(input.searchTexts, results, limit)
        } catch (error) {
            this.logger.warn(
                'search.rerank.failed',
                { operation: 'rerank', model: this.config.rerankModel },
                error
            )
            return results.slice(0, limit)
        }
    }

    /**
     * 每条查询短语各自重排一次，候选取各次得分的最大值，与混合检索多向量
     * 取最大的合并口径一致；未被任何一次重排返回的候选不进入结果。
     */
    private async rerank(
        searchTexts: string[],
        candidates: LivingMemorySearchDetailedResult[],
        limit: number
    ): Promise<LivingMemorySearchDetailedResult[]> {
        const reranker = (
            await this.ctx.chatluna.createReranker(this.config.rerankModel)
        ).value
        if (reranker == null) {
            throw new Error(
                `memory search reranker unavailable: model=${this.config.rerankModel}`
            )
        }

        const documents = candidates.map((candidate) => candidate.content)
        const rankings = await Promise.all(
            searchTexts.map((searchText) =>
                reranker.rerank(documents, searchText, {
                    topN: documents.length
                })
            )
        )
        const bestScores = new Map<number, number>()
        for (const ranking of rankings) {
            for (const { index, relevanceScore } of ranking) {
                if (candidates[index] == null) {
                    throw new Error(
                        `memory rerank index out of bounds: index=${index}, ` +
                            `candidateCount=${candidates.length}`
                    )
                }
                bestScores.set(
                    index,
                    Math.max(bestScores.get(index) ?? -Infinity, relevanceScore)
                )
            }
        }

        return [...bestScores]
            .sort(
                ([leftIndex, leftScore], [rightIndex, rightScore]) =>
                    rightScore - leftScore || leftIndex - rightIndex
            )
            .slice(0, limit)
            .map(([index, rerankScore]) => ({
                ...candidates[index],
                rerankScore
            }))
    }
}
