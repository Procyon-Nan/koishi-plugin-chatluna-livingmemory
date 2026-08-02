import { type Context, type Logger } from 'koishi'
import type {
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
    'embeddingModel' | 'debug'
>

interface EmbeddingSearchQuery {
    broadTexts: string[]
    specificTexts: string[]
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

interface MergedScore {
    entry: MemoryEntryRecord
    score: number
    matchedBroad: string[]
    matchedSpecific: string[]
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
        const broadTexts = options.query.broadTexts
        const specificTexts = options.query.specificTexts
        const allTexts = [...broadTexts, ...specificTexts]
        if (allTexts.length === 0) {
            return []
        }

        const queryVectors = await cache.embeddings.embedDocuments(allTexts)
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
                    ...(this.config.debug
                        ? { debug: (msg: string) => this.logger.info(msg) }
                        : {})
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

        // 6. 对每个查询向量调用共享的 rankEntriesByQueryVector，按 best score 合并
        const mergedByEntry = new Map<string, MergedScore>()

        for (let qi = 0; qi < queryVectors.length; qi++) {
            const queryVector = queryVectors[qi]
            const isBroad = qi < broadTexts.length
            const text = isBroad
                ? broadTexts[qi]
                : specificTexts[qi - broadTexts.length]

            const ranked = rankEntriesByQueryVector(
                filtered,
                cache.embeddingMap,
                queryVector
            )

            for (const { entry, score } of ranked) {
                let merged = mergedByEntry.get(entry.id)
                if (merged == null) {
                    merged = {
                        entry,
                        score: -Infinity,
                        matchedBroad: [],
                        matchedSpecific: []
                    }
                    mergedByEntry.set(entry.id, merged)
                }
                if (score > merged.score) {
                    merged.score = score
                }
                if (score > 0) {
                    if (isBroad) {
                        merged.matchedBroad.push(text)
                    } else {
                        merged.matchedSpecific.push(text)
                    }
                }
            }
        }

        return [...mergedByEntry.values()]
            .sort((left, right) => right.score - left.score)
            .slice(0, options.maxCandidates)
            .map(({ entry, matchedBroad, matchedSpecific }) => ({
                id: entry.id,
                type: entry.type,
                content: entry.content,
                keywords: [...entry.keywords],
                summary: entry.summary,
                importance: entry.importance,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
                matchedBroadSearchTexts: matchedBroad,
                matchedSpecificSearchTexts: matchedSpecific
            }))
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
