import { type Context, type Logger } from 'koishi'
import type {
    LivingMemorySearchDetailedResult,
    LivingMemorySearchMemoryType,
    LivingMemorySearchResult,
    MemoryEntryRecord
} from '../../../contracts/memory'
import type {
    LivingMemoryConfig,
    RecallRepository
} from '../../../contracts/workflows'
import { isModelConfigured } from '../../shared/utils'
import {
    type EmbeddingsLike,
    ensureEntryEmbeddings,
    rankEntriesByQueryVector
} from '../../shared/embeddings'

type EmbeddingSearchEngineConfig = Pick<
    LivingMemoryConfig,
    'embeddingModel' | 'memorySearchMinSimilarity' | 'debug'
>

interface EmbeddingSearchQuery {
    texts: string[]
    keywords: string[]
}

interface EmbeddingSearchOptions {
    presetId: string
    query: EmbeddingSearchQuery
    memoryTypes: LivingMemorySearchMemoryType[]
    maxCandidates: number
}

/** Run 级缓存，由调用方在每个 agent run 开始时创建 */
export interface EmbeddingSearchCache {
    presetId: string | null
    entries: MemoryEntryRecord[]
    embeddingMap: Map<string, number[]> | null
    embeddings: EmbeddingsLike | null
}

export const createEmbeddingSearchCache = (): EmbeddingSearchCache => ({
    presetId: null,
    entries: [],
    embeddingMap: null,
    embeddings: null
})

/** 语义命中且关键词也命中时，每个命中关键词的分数增量 */
const KEYWORD_MATCH_BOOST = 0.15

/** 仅关键词命中（无语义命中）时，每个命中关键词的基础分数 */
const KEYWORD_ONLY_BASE_SCORE = 0.3

interface ScoredEntry {
    entry: MemoryEntryRecord
    cosineScore: number
    keywordMatchCount: number
    boostedScore: number
}

/**
 * 统计 entry.keywords 中与查询关键词精确匹配（大小写不敏感）的数量。
 */
const countKeywordMatches = (
    entry: Pick<MemoryEntryRecord, 'keywords'>,
    keywordSet: Set<string>
): number => {
    let count = 0
    for (const kw of entry.keywords) {
        if (keywordSet.has(kw.toLowerCase())) {
            count += 1
        }
    }
    return count
}

export class LivingMemoryEmbeddingSearchEngine {
    constructor(
        private readonly ctx: Context,
        private readonly config: EmbeddingSearchEngineConfig,
        private readonly repository: RecallRepository,
        private readonly logger: Logger
    ) {}

    async search(
        options: EmbeddingSearchOptions,
        cache: EmbeddingSearchCache
    ): Promise<LivingMemorySearchResult[]> {
        const scored = await this.searchScored(options, cache)
        return scored.map(({ entry }) => this.toSearchResult(entry))
    }

    async searchDetailed(
        options: EmbeddingSearchOptions,
        cache: EmbeddingSearchCache
    ): Promise<LivingMemorySearchDetailedResult[]> {
        const scored = await this.searchScored(options, cache)
        return scored.map(
            ({ entry, cosineScore, keywordMatchCount, boostedScore }) => ({
                ...this.toSearchResult(entry),
                cosineScore,
                keywordMatchCount,
                boostedScore
            })
        )
    }

    private async searchScored(
        options: EmbeddingSearchOptions,
        cache: EmbeddingSearchCache
    ): Promise<ScoredEntry[]> {
        if (!isModelConfigured(this.config.embeddingModel)) {
            throw new Error('agentic recall embedding model is not configured')
        }

        // 1. entries 缓存：preset 切换时重新加载
        if (cache.presetId !== options.presetId) {
            const all = await this.repository.listEntriesByPreset(
                options.presetId
            )
            cache.presetId = options.presetId
            cache.entries = all.filter((entry) => entry.status === 'active')
            cache.embeddingMap = null
            cache.embeddings = null
        }

        if (cache.entries.length === 0) {
            return []
        }

        // 2. embeddings 实例缓存
        if (cache.embeddings === null) {
            const result = await this.ctx.chatluna.createEmbeddings(
                this.config.embeddingModel
            )
            if (result?.value == null) {
                throw new Error(
                    `agentic recall embedding unavailable: model=${this.config.embeddingModel}`
                )
            }
            cache.embeddings = result.value
        }

        // 3. 批量 embed 查询文本（每次调用的查询不同）
        const texts = options.query.texts
        if (texts.length === 0) {
            return []
        }

        const queryVectors = await cache.embeddings.embedDocuments(texts)
        if (queryVectors.length === 0 || queryVectors[0].length === 0) {
            throw new Error('agentic recall embedding query vectors are empty')
        }

        // 4. entry embeddings 缓存：首次计算（含 DB 回填），后续命中
        if (cache.embeddingMap === null) {
            cache.embeddingMap = await ensureEntryEmbeddings(
                cache.embeddings,
                this.repository,
                this.config.embeddingModel,
                cache.entries,
                {
                    logger: this.logger,
                    // 首条查询向量的维度即当前模型输出维度，
                    // 以此让维度不一致的旧缓存向量失效重算。
                    expectedDimension: queryVectors[0].length,
                    debug: (msg: string) => this.debugLog(msg)
                }
            )
        }

        // 5. memoryTypes 过滤
        const typeSet = this.resolveMemoryTypes(options.memoryTypes)
        const filtered = typeSet
            ? cache.entries.filter((entry) => typeSet.has(entry.type))
            : cache.entries

        if (filtered.length === 0) {
            return []
        }

        // 6. 对每个查询向量调用共享的 rankEntriesByQueryVector，按 best cosine score 合并
        const bestCosineByEntry = new Map<
            string,
            { entry: MemoryEntryRecord; cosineScore: number }
        >()

        for (let qi = 0; qi < queryVectors.length; qi++) {
            const queryVector = queryVectors[qi]

            const ranked = rankEntriesByQueryVector(
                filtered,
                cache.embeddingMap,
                queryVector
            )

            for (const { entry, score } of ranked) {
                const existing = bestCosineByEntry.get(entry.id)
                if (existing == null) {
                    bestCosineByEntry.set(entry.id, {
                        entry,
                        cosineScore: score
                    })
                } else if (score > existing.cosineScore) {
                    existing.cosineScore = score
                }
            }
        }

        // 6.5 阈值过滤：滤掉 cosine 低于阈值的条目（threshold > 0 时）
        const threshold = this.config.memorySearchMinSimilarity
        if (threshold > 0) {
            for (const [id, record] of bestCosineByEntry) {
                if (record.cosineScore < threshold) {
                    bestCosineByEntry.delete(id)
                }
            }
        }

        // 7. 关键词 boost 融合
        const queryKeywords = options.query.keywords
        const keywordSet =
            queryKeywords.length > 0
                ? new Set(
                      queryKeywords
                          .map((k) => k.trim().toLowerCase())
                          .filter((k) => k.length > 0)
                  )
                : null

        const scored: ScoredEntry[] = []

        // 7a. 语义结果中命中关键词的条目：按命中数累加 boost
        for (const { entry, cosineScore } of bestCosineByEntry.values()) {
            const matchCount =
                keywordSet != null ? countKeywordMatches(entry, keywordSet) : 0
            scored.push({
                entry,
                cosineScore,
                keywordMatchCount: matchCount,
                boostedScore: cosineScore + KEYWORD_MATCH_BOOST * matchCount
            })
        }

        // 7b. 不在语义结果中（被阈值过滤或无语义命中）但关键词命中的条目
        if (keywordSet != null && keywordSet.size > 0) {
            for (const entry of filtered) {
                if (bestCosineByEntry.has(entry.id)) continue
                const matchCount = countKeywordMatches(entry, keywordSet)
                if (matchCount > 0) {
                    scored.push({
                        entry,
                        cosineScore: 0,
                        keywordMatchCount: matchCount,
                        boostedScore: KEYWORD_ONLY_BASE_SCORE * matchCount
                    })
                }
            }
        }

        // 8. 排序、截断
        return scored
            .sort((left, right) => right.boostedScore - left.boostedScore)
            .slice(0, options.maxCandidates)
    }

    private toSearchResult(entry: MemoryEntryRecord): LivingMemorySearchResult {
        return {
            id: entry.id,
            type: entry.type,
            content: entry.content,
            keywords: [...entry.keywords],
            summary: entry.summary,
            importance: entry.importance,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
        }
    }

    private debugLog(message: string) {
        if (this.config.debug) {
            this.logger.info(message)
        }
    }

    private resolveMemoryTypes(
        types: LivingMemorySearchMemoryType[]
    ): Set<MemoryEntryRecord['type']> | null {
        if (types.includes('all')) {
            return null
        }
        return new Set(types as MemoryEntryRecord['type'][])
    }
}
