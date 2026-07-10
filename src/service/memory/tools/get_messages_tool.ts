import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    livingMemoryGetMessagesInputSchema,
    livingMemoryGetMessagesToolInputSchema,
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
    `- memoryIds: 1 to ${memoryGetMessagesMaxIdCount} memory ids from living_memory_search results.`,
    '- The tool only reads memories owned by the current preset.',
    '- Each result includes the target memory id, type, content, summary, keywords, importance, timestamps, and sourceOrigins.',
    '- sourceOrigins are indexed with originIndex for display. Missing source origins mean the memory has no recorded source messages.',
    '- The result also includes notFoundMemoryIds for ids that do not exist in the current preset.'
].join('\n')

type LivingMemoryGetMessagesToolInput = z.infer<
    typeof livingMemoryGetMessagesToolInputSchema
>

const invalidArgumentRetryMessage =
    'living_memory_get_messages input is invalid. Correct the arguments and call this tool again.'
const toolCallFailedMessage =
    'living_memory_get_messages failed because invalid arguments were provided 3 times. ' +
    'Do not call this tool again for this request. Continue replying with the ' +
    'context that the memory source message tool call failed.'

export class LivingMemoryGetMessagesTool extends StructuredTool {
    name = livingMemoryGetMessagesToolName
    description = livingMemoryGetMessagesToolDescription

    schema = livingMemoryGetMessagesToolInputSchema
    private readonly runtime: LivingMemoryToolRuntime

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryGetMessagesToolConfig
    ) {
        super()
        this.runtime = new LivingMemoryToolRuntime(
            {
                toolName: livingMemoryGetMessagesToolName,
                logger: ctx.logger('chatluna-livingmemory'),
                isDebugEnabled: () => this.config.debug,
                invalidArgumentRetryMessage,
                toolCallFailedMessage
            },
            this
        )
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

        if (this.runtime.hasReachedRetryLimit(configurable)) {
            return this.runtime.createRetryLimitOutput(configurable)
        }

        const parsedInput = livingMemoryGetMessagesInputSchema.safeParse(input)
        if (!parsedInput.success) {
            return this.runtime.createInvalidArgumentOutput(
                configurable,
                this.runtime.formatValidationErrors(parsedInput.error)
            )
        }

        const livingMemory = this.ctx.get('chatluna_living_memory')
        const result = await livingMemory.getMemorySourceMessages(
            presetId,
            parsedInput.data.memoryIds
        )
        this.runtime.clearInvalidArgumentRetry(configurable)

        const output = JSON.stringify(result, null, 2)

        this.runtime.logOutput(configurable, output, [
            `resultCount=${result.memories.length}`,
            `notFoundCount=${result.notFoundMemoryIds.length}`
        ])

        return output
    }
}
