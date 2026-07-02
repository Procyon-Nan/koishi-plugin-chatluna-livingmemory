import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context, Logger } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { z } from 'zod'
import type { Config } from '../index'
import {
    broadSearchTextRule,
    formatSearchTextLengthRange,
    livingMemorySearchInputSchema,
    livingMemorySearchToolName,
    memorySearchMaxTextCount,
    specificSearchTextRule
} from '../service/memory/search_contract'

const toolDescription = [
    'Search active memories in the current preset by lexical phrase matching.',
    '',
    'Use this tool when you need to look up existing memories by both broad and specific search phrases.',
    `- broadSearchTexts: 1 to ${memorySearchMaxTextCount} short, broad phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(broadSearchTextRule)} characters after trimming. ` +
        'Use broad topics, categories, or general needs.',
    `- specificSearchTexts: optional but recommended, 1 to ${memorySearchMaxTextCount} longer, specific phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(specificSearchTextRule)} characters after trimming when provided.`,
    '  Use concrete constraints, entities, preferences, or short factual phrases.',
    '- memoryTypes: memory categories to search, or ["all"] to search every category.',
    '- The tool only searches active memories owned by the current preset.',
    '- Specific phrase matches receive higher score than broad phrase matches. Memories matching multiple phrases receive additional score.',
    '- Each result includes matchedBroadSearchTexts and matchedSpecificSearchTexts so you can see which query phrases matched that memory.',
    '- The result is a JSON array of memory records sorted by lexical relevance, importance, then recent update time.'
].join('\n')

type ChatLunaStructuredTool = ReturnType<ChatLunaTool['createTool']>

const toChatLunaStructuredTool = (
    tool: LivingMemorySearchTool
): ChatLunaStructuredTool => {
    // ChatLuna and this package can resolve different @langchain/core copies in
    // local workspaces, so keep the cast at the registration boundary.
    return tool as unknown as ChatLunaStructuredTool
}

const toolMeta = {
    source: 'extension',
    group: 'living-memory',
    tags: ['living-memory', 'search'],
    defaultAvailability: {
        enabled: true,
        main: true,
        chatluna: true,
        characterScope: 'all' as const
    }
}

export function apply(ctx: Context, config: Config) {
    ctx.on('ready', () => {
        const dispose = ctx.chatluna.platform.registerTool(
            livingMemorySearchToolName,
            {
                description: toolDescription,
                selector(_history: unknown[]) {
                    return true
                },
                meta: toolMeta,
                createTool() {
                    return toChatLunaStructuredTool(
                        new LivingMemorySearchTool(ctx, config)
                    )
                }
            }
        )

        ctx.effect(() => dispose)
    })
}

class LivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = toolDescription

    schema = livingMemorySearchInputSchema
    private readonly logger: Logger

    constructor(
        private readonly ctx: Context,
        private readonly config: Config
    ) {
        super()
        this.logger = ctx.logger('chatluna-livingmemory')
    }

    private debug(message: string) {
        if (this.config.debug) {
            this.logger.info(message)
        }
    }

    async _call(
        input: z.infer<typeof livingMemorySearchInputSchema>,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const configurable = runConfig?.configurable
        const presetId = configurable?.preset

        this.debug(
            [
                'living_memory_search input:',
                `presetId=${configurable?.preset ?? ''}`,
                `conversationId=${configurable?.conversationId ?? ''}`,
                `userId=${configurable?.userId ?? ''}`,
                `source=${configurable?.source ?? ''}`,
                JSON.stringify(input, null, 2)
            ].join('\n')
        )

        if (typeof presetId !== 'string' || presetId.length === 0) {
            throw new Error('Missing preset in the current tool call.')
        }

        const results = await this.ctx.chatluna_living_memory.searchMemories(
            presetId,
            {
                broadSearchTexts: input.broadSearchTexts,
                specificSearchTexts: input.specificSearchTexts,
                memoryTypes: input.memoryTypes,
                maxCandidates: this.config.memorySearchToolMaxResults
            }
        )

        const output = JSON.stringify(results, null, 2)

        this.debug(
            [
                'living_memory_search output:',
                `presetId=${configurable?.preset ?? ''}`,
                `conversationId=${configurable?.conversationId ?? ''}`,
                `userId=${configurable?.userId ?? ''}`,
                `source=${configurable?.source ?? ''}`,
                `resultCount=${results.length}`,
                output
            ].join('\n')
        )

        return output
    }
}
