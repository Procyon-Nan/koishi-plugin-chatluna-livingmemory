import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryLogger } from '../../logging/logger'
import {
    livingMemoryGetMessagesInputSchema,
    livingMemoryGetMessagesToolName,
    memoryGetMessagesMaxIdCount
} from './search_contract'
import {
    getLivingMemoryToolConfigurable,
    LivingMemoryToolRuntime
} from './tool_runtime'

export const livingMemoryGetMessagesToolDescription = [
    '按记忆 ID 获取当前预设中记忆的来源对话消息。',
    '',
    '当你需要查看特定记忆是否有来源对话消息支撑时使用此工具。',
    `- memoryIds：必填 JSON 数组，包含 1 到 ${memoryGetMessagesMaxIdCount} 个来自 living_memory_search 结果的记忆 ID。`,
    '- 直接传递数组，禁止把数组编码成 JSON 字符串。',
    '- 本工具仅读取当前预设拥有的记忆。',
    '- 每条结果包含目标记忆 ID、类别（type）、内容（content）、摘要（summary）、关键词（keywords）、重要度（importance）、时间戳以及 sourceOrigins。',
    '- sourceOrigins 以 originIndex 索引展示。缺失的来源表示该记忆没有记录的来源消息。',
    '- 结果中还包含 notFoundMemoryIds，列出在当前预设中不存在的 ID。'
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
        logger: LivingMemoryLogger
    ) {
        super({ verboseParsingErrors: true })
        this.runtime = new LivingMemoryToolRuntime({
            toolName: livingMemoryGetMessagesToolName,
            logger
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
        if (!livingMemory) {
            throw new Error('Living Memory service not available')
        }
        const result = await livingMemory.getMemorySourceMessages(
            presetId,
            input.memoryIds
        )

        const output = JSON.stringify(result, null, 2)

        this.runtime.logOutput(configurable, output, {
            resultCount: result.memories.length,
            notFoundCount: result.notFoundMemoryIds.length
        })

        return output
    }
}
