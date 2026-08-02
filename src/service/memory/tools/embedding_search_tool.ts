import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    formatSearchTextLengthRange,
    livingMemoryEmbeddingSearchInputSchema,
    livingMemorySearchToolName,
    memorySearchMaxTextCount,
    searchTextRule
} from './search_contract'
import {
    getLivingMemoryToolConfigurable,
    LivingMemoryToolRuntime
} from './tool_runtime'
import type {
    EmbeddingSearchCache,
    LivingMemoryEmbeddingSearchEngine
} from '../../workflows/recall/embedding_search_engine'

type LivingMemoryEmbeddingSearchToolConfig = Pick<
    LivingMemoryConfig,
    'debug' | 'memorySearchToolMaxResults'
>

export const livingMemoryEmbeddingSearchToolDescription = [
    'Search active memories in the current preset by semantic similarity.',
    '',
    'Use this tool when you need to look up existing memories by meaning, not exact wording.',
    `- searchTexts: required JSON array containing 1 to ${memorySearchMaxTextCount} semantic query phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(searchTextRule)} characters after trimming. ` +
        'Use broad topics, concrete descriptions, or factual phrases.',
    '- memoryTypes: required JSON array of memory categories, or ["all"] to search every category.',
    '- Pass arrays directly. Never encode an array as a JSON string.',
    '- The tool searches active memories owned by the current preset using embedding cosine similarity.',
    '- Results are sorted by best similarity score across all provided query texts.'
].join('\n')

type LivingMemoryEmbeddingSearchToolInput = z.infer<
    typeof livingMemoryEmbeddingSearchInputSchema
>

export class LivingMemoryEmbeddingSearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = livingMemoryEmbeddingSearchToolDescription

    schema = livingMemoryEmbeddingSearchInputSchema
    private readonly runtime: LivingMemoryToolRuntime

    constructor(
        private readonly engine: LivingMemoryEmbeddingSearchEngine,
        private readonly cache: EmbeddingSearchCache,
        ctx: Context,
        private readonly config: LivingMemoryEmbeddingSearchToolConfig
    ) {
        super({ verboseParsingErrors: true })
        this.runtime = new LivingMemoryToolRuntime({
            toolName: livingMemorySearchToolName,
            logger: ctx.logger('chatluna-livingmemory'),
            isDebugEnabled: () => this.config.debug
        })
    }

    async _call(
        input: LivingMemoryEmbeddingSearchToolInput,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const configurable = getLivingMemoryToolConfigurable(runConfig)
        const presetId = configurable?.preset

        this.runtime.logInput(configurable, input)

        if (typeof presetId !== 'string' || presetId.length === 0) {
            throw new Error('Missing preset in the current tool call.')
        }

        const results = await this.engine.search(
            {
                presetId,
                query: {
                    texts: input.searchTexts
                },
                memoryTypes: input.memoryTypes,
                maxCandidates: this.config.memorySearchToolMaxResults
            },
            this.cache
        )

        const output = JSON.stringify(results, null, 2)

        this.runtime.logOutput(configurable, output, [
            `resultCount=${results.length}`
        ])

        return output
    }
}
