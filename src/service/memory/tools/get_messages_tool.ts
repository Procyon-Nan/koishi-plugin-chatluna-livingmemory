import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import { renderMemorySourceMessagesForModel } from '../../prompts/memory_entries'
import {
    livingMemoryGetMessagesInputSchema,
    livingMemoryGetMessagesToolName
} from './search_contract'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId
} from './tool_runtime'

export const livingMemoryGetMessagesToolDescription = [
    '查看单条记忆的来源对话消息。',
    '',
    '当你需要确认某条记忆的原始对话依据时使用此工具。',
    '- memoryId：必填字符串，来自 living_memory_search 结果的记忆 ID。',
    '- 每次只查看一条记忆；结果按原始聊天记录格式渲染其全部来源对话，多段来源分组编号。',
    '- 没有记录来源消息的记忆会明确说明。',
    '- 本工具仅读取当前预设拥有的记忆。'
].join('\n')

type LivingMemoryGetMessagesToolInput = z.infer<
    typeof livingMemoryGetMessagesInputSchema
>

export class LivingMemoryGetMessagesTool extends StructuredTool {
    name = livingMemoryGetMessagesToolName
    description = livingMemoryGetMessagesToolDescription

    schema = livingMemoryGetMessagesInputSchema

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
