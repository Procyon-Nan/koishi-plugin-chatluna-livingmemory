import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    livingMemoryGetMessagesInputSchema,
    livingMemoryGetMessagesToolName,
    memoryGetMessagesMaxIdCount
} from './search_contract'
import {
    getLivingMemoryToolConfigurable,
    LivingMemoryToolRuntime
} from './tool_runtime'

type LivingMemoryGetMessagesToolConfig = Pick<LivingMemoryConfig, 'debug'>

export const livingMemoryGetMessagesToolDescription = [
    'Get source conversation messages for memories in the current preset by memory id.',
    '',
    'Use this tool when you need to inspect whether specific memories are supported by their source conversation messages.',
    `- memoryIds: required JSON array containing 1 to ${memoryGetMessagesMaxIdCount} memory ids from living_memory_search results.`,
    '- Pass the array directly. Never encode it as a JSON string.',
    '- The tool only reads memories owned by the current preset.',
    '- Each result includes the target memory id, type, content, summary, keywords, importance, timestamps, and sourceOrigins.',
    '- sourceOrigins are indexed with originIndex for display. Missing source origins mean the memory has no recorded source messages.',
    '- The result also includes notFoundMemoryIds for ids that do not exist in the current preset.'
].join('\n')

type LivingMemoryGetMessagesToolInput = z.infer<
    typeof livingMemoryGetMessagesInputSchema
>

export class LivingMemoryGetMessagesTool extends StructuredTool {
    name = livingMemoryGetMessagesToolName
    description = livingMemoryGetMessagesToolDescription

    schema = livingMemoryGetMessagesInputSchema
    private readonly runtime: LivingMemoryToolRuntime

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryGetMessagesToolConfig
    ) {
        super({ verboseParsingErrors: true })
        this.runtime = new LivingMemoryToolRuntime({
            toolName: livingMemoryGetMessagesToolName,
            logger: ctx.logger('chatluna-livingmemory'),
            isDebugEnabled: () => this.config.debug
        })
    }

    async _call(
        input: LivingMemoryGetMessagesToolInput,
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
        const result = await livingMemory.getMemorySourceMessages(
            presetId,
            input.memoryIds
        )

        const output = JSON.stringify(result, null, 2)

        this.runtime.logOutput(configurable, output, [
            `resultCount=${result.memories.length}`,
            `notFoundCount=${result.notFoundMemoryIds.length}`
        ])

        return output
    }
}
