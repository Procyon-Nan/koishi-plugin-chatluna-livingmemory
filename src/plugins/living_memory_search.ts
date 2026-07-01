import { StructuredTool } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { z } from 'zod'
import { livingMemorySearchMemoryTypes } from '../types'
import type { Config } from '../index'

const livingMemorySearchToolName = 'living_memory_search'

const toolDescription = `Search active memories in the current preset by lexical phrase matching.

Use this tool when you need to look up existing memories by short search phrases.
- searchTexts: 1 to 5 query phrases. Each phrase must be 2 to 6 characters after trimming.
- memoryTypes: memory categories to search, or ["all"] to search every category.
- The tool only searches active memories owned by the current preset.
- The result is a JSON array of memory records sorted by lexical relevance, importance, then recent update time.`

const searchSchema = z.object({
    searchTexts: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe(
            'Search phrases. Provide 1 to 5 phrases, each 2 to 6 characters after trimming.'
        ),
    memoryTypes: z
        .array(z.enum(livingMemorySearchMemoryTypes))
        .min(1)
        .describe(
            'Memory categories to search. Use concrete categories or all.'
        )
})

interface LivingMemorySearchRunConfig {
    configurable?: {
        preset?: unknown
    }
}

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

    schema = searchSchema

    constructor(
        private readonly ctx: Context,
        private readonly config: Config
    ) {
        super()
    }

    async _call(
        input: z.infer<typeof searchSchema>,
        _runManager: unknown,
        runConfig?: LivingMemorySearchRunConfig
    ) {
        const presetId = runConfig?.configurable?.preset
        if (typeof presetId !== 'string' || presetId.length === 0) {
            throw new Error('Missing preset in the current tool call.')
        }

        const results = await this.ctx.chatluna_living_memory.searchMemories(
            presetId,
            {
                searchTexts: input.searchTexts,
                memoryTypes: input.memoryTypes,
                maxCandidates: this.config.memorySearchToolMaxResults
            }
        )

        return JSON.stringify(results, null, 2)
    }
}
