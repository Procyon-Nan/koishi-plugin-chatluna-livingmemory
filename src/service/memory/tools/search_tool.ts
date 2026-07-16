import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    broadSearchTextRule,
    formatSearchTextLengthRange,
    livingMemorySearchInputSchema,
    livingMemorySearchToolName,
    memorySearchMaxTextCount,
    specificSearchTextRule
} from './search_contract'
import {
    getLivingMemoryToolConfigurable,
    LivingMemoryToolRuntime
} from './tool_runtime'

type LivingMemorySearchToolConfig = Pick<
    LivingMemoryConfig,
    'debug' | 'memorySearchToolMaxResults'
>

export const livingMemorySearchToolDescription = [
    'Search active memories in the current preset by lexical phrase matching.',
    '',
    'Use this tool when you need to look up existing memories by both broad and specific search phrases.',
    `- broadSearchTexts: required JSON array containing 1 to ${memorySearchMaxTextCount} short, broad phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(broadSearchTextRule)} characters after trimming. ` +
        'Use broad topics, categories, or general needs.',
    `- specificSearchTexts: optional JSON array containing 1 to ${memorySearchMaxTextCount} longer, specific phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(specificSearchTextRule)} characters after trimming when provided.`,
    '  Use concrete constraints, entities, preferences, or factual phrases.',
    '- memoryTypes: required JSON array of memory categories, or ["all"] to search every category.',
    '- Pass arrays directly. Never encode an array as a JSON string.',
    '- The tool only searches active memories owned by the current preset.',
    '- Specific phrase matches receive higher score than broad phrase matches. Memories matching multiple phrases receive additional score.',
    '- Each result includes matchedBroadSearchTexts and matchedSpecificSearchTexts so you can see which query phrases matched that memory.',
    '- The result is a JSON array of memory records sorted by lexical relevance, importance, then recent update time.'
].join('\n')

type LivingMemorySearchToolInput = z.infer<typeof livingMemorySearchInputSchema>

export class LivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = livingMemorySearchToolDescription

    schema = livingMemorySearchInputSchema
    private readonly runtime: LivingMemoryToolRuntime

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemorySearchToolConfig
    ) {
        super({ verboseParsingErrors: true })
        this.runtime = new LivingMemoryToolRuntime({
            toolName: livingMemorySearchToolName,
            logger: ctx.logger('chatluna-livingmemory'),
            isDebugEnabled: () => this.config.debug
        })
    }

    async _call(
        input: LivingMemorySearchToolInput,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const configurable = getLivingMemoryToolConfigurable(runConfig)
        const presetId = configurable?.preset

        this.runtime.logInput(configurable, input)

        if (typeof presetId !== 'string' || presetId.length === 0) {
            throw new Error('Missing preset in the current tool call.')
        }

        const livingMemory = this.ctx.get('chatluna_living_memory')
        const results = await livingMemory.searchMemories(presetId, {
            broadSearchTexts: input.broadSearchTexts,
            specificSearchTexts: input.specificSearchTexts,
            memoryTypes: input.memoryTypes,
            maxCandidates: this.config.memorySearchToolMaxResults
        })

        const output = JSON.stringify(results, null, 2)

        this.runtime.logOutput(configurable, output, [
            `resultCount=${results.length}`
        ])

        return output
    }
}
