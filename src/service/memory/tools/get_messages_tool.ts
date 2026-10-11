import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import { renderMemorySourceMessagesForModel } from '../../prompts/memory_entries'
import { memoryGetMessagesTool } from '../../prompts/memory_tools'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId
} from './tool_runtime'

type LivingMemoryGetMessagesToolInput = z.infer<
    typeof memoryGetMessagesTool.schema
>

export class LivingMemoryGetMessagesTool extends StructuredTool {
    name = memoryGetMessagesTool.name
    description = memoryGetMessagesTool.description

    schema = memoryGetMessagesTool.schema

    constructor(private readonly ctx: Context) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: LivingMemoryGetMessagesToolInput,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const configurable = getLivingMemoryToolConfigurable(runConfig)
        const presetIdResolution = resolveToolMemoryPresetId(configurable)
        if (presetIdResolution.ok === false) {
            throw new Error(
                describeLivingMemoryToolScopeFailure(presetIdResolution.reason)
            )
        }

        const livingMemory = this.ctx.get('chatluna_living_memory')
        if (!livingMemory) {
            throw new Error('Living Memory service not available')
        }
        const memory = await livingMemory.getMemorySourceMessages(
            presetIdResolution.presetId,
            input.memoryId
        )

        if (memory == null) {
            return `记忆 ${input.memoryId} 不存在于当前预设。`
        }
        return renderMemorySourceMessagesForModel(memory)
    }
}
