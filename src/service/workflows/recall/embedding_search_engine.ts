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
import { loadIndexedMemoryEntries } from './indexed_entries'

type EmbeddingSearchEngineConfig = Pick<
    LivingMemoryConfig,
    'memorySearchToolMaxResults' | 'memorySearchMinSimilarity'
>

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
        private readonly config: EmbeddingSearchEngineConfig,
        private readonly repository: RecallRepository,
        private readonly vectorSearch: MemoryVectorSearch
    ) {}

    async searchMemories(
        presetId: string,
        input: LivingMemorySearchInput
    ): Promise<LivingMemorySearchResult[]> {
        const detailed = await this.searchMemoriesDetailed(presetId, input)
        return detailed.map((entry) => ({
            id: entry.id,
            type: entry.type,
            content: entry.content,
            keywords: [...entry.keywords],
            summary: entry.summary,
            sentiment: entry.sentiment,
            importance: entry.importance,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
        }))
    }

    async searchMemoriesDetailed(
        presetId: string,
        input: LivingMemorySearchInput
    ): Promise<LivingMemorySearchDetailedResult[]> {
        const hits = await this.vectorSearch.searchHybrid({
            presetId,
            searchTexts: input.searchTexts,
            keywords: input.searchKeywords ?? [],
            memoryTypes: resolveMemoryTypes(input),
            maxCandidates: this.config.memorySearchToolMaxResults,
            minSimilarity: this.config.memorySearchMinSimilarity
        })
        const entries = await loadIndexedMemoryEntries(
            this.repository,
            presetId,
            hits.map((hit) => hit.memoryId)
        )

        return entries.map((entry, index) => {
            const hit = hits[index]
            return {
                id: entry.id,
                type: entry.type,
                content: entry.content,
                keywords: [...entry.keywords],
                summary: entry.summary,
                sentiment: entry.sentiment,
                importance: entry.importance,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
                cosineScore: hit.cosineScore,
                keywordMatchCount: hit.keywordMatchCount,
                boostedScore: hit.boostedScore
            }
        })
    }
}
