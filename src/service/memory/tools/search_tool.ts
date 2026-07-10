import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryConfig } from '../../../types'
import {
    broadSearchTextRule,
    formatSearchTextLengthRange,
    livingMemorySearchInputSchema,
    livingMemorySearchToolInputSchema,
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
    `- broadSearchTexts: 1 to ${memorySearchMaxTextCount} short, broad phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(broadSearchTextRule)} characters after trimming. ` +
        'Use broad topics, categories, or general needs.',
    `- specificSearchTexts: optional but recommended, 1 to ${memorySearchMaxTextCount} longer, specific phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(specificSearchTextRule)} characters after trimming when provided.`,
    '  Use concrete constraints, entities, preferences, or factual phrases.',
    '- memoryTypes: memory categories to search, or ["all"] to search every category.',
    '- The tool only searches active memories owned by the current preset.',
    '- Specific phrase matches receive higher score than broad phrase matches. Memories matching multiple phrases receive additional score.',
    '- Each result includes id. Use living_memory_get_messages with these ids when you need source conversation messages.',
    '- Each result includes matchedBroadSearchTexts and matchedSpecificSearchTexts so you can see which query phrases matched that memory.',
    '- The result is a JSON array of memory records sorted by lexical relevance, importance, then recent update time.'
].join('\n')

type LivingMemorySearchToolInput = z.infer<
    typeof livingMemorySearchToolInputSchema
>

const invalidArgumentRetryMessage =
    'living_memory_search input is invalid. Correct the arguments and call this tool again.'
const toolCallFailedMessage =
    'living_memory_search failed because invalid arguments were provided 3 times. ' +
    'Do not call this tool again for this request. Continue replying with the ' +
    'context that the memory search tool call failed.'

export class LivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = livingMemorySearchToolDescription

    schema = livingMemorySearchToolInputSchema
    private readonly runtime: LivingMemoryToolRuntime

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemorySearchToolConfig
    ) {
        super()
        this.runtime = new LivingMemoryToolRuntime(
            {
                toolName: livingMemorySearchToolName,
                logger: ctx.logger('chatluna-livingmemory'),
                isDebugEnabled: () => this.config.debug,
                invalidArgumentRetryMessage,
                toolCallFailedMessage
            },
            this
        )
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

        if (this.runtime.hasReachedRetryLimit(configurable)) {
            return this.runtime.createRetryLimitOutput(configurable)
        }

        const parsedInput = livingMemorySearchInputSchema.safeParse(input)
        if (!parsedInput.success) {
            return this.runtime.createInvalidArgumentOutput(
                configurable,
                this.runtime.formatValidationErrors(parsedInput.error)
            )
        }

        const livingMemory = this.ctx.get('chatluna_living_memory')
        const results = await livingMemory.searchMemories(presetId, {
            broadSearchTexts: parsedInput.data.broadSearchTexts,
            specificSearchTexts: parsedInput.data.specificSearchTexts,
            memoryTypes: parsedInput.data.memoryTypes,
            maxCandidates: this.config.memorySearchToolMaxResults
        })
        this.runtime.clearInvalidArgumentRetry(configurable)

        const output = JSON.stringify(results, null, 2)

        this.runtime.logOutput(configurable, output, [
            `resultCount=${results.length}`
        ])

        return output
    }
}
