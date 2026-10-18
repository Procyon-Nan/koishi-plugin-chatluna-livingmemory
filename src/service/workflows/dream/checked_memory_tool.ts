import { StructuredTool } from '@langchain/core/tools'
import type { z } from 'zod'
import { memoryCheckedTool } from '../../prompts/memory_tools'

export class LivingMemoryCheckedMemoryTool extends StructuredTool {
    name = memoryCheckedTool.name
    description = memoryCheckedTool.description
    schema = memoryCheckedTool.schema

    // 集合由单次任务持有；其他操作成功后也写入同一个处理集合。
    constructor(
        private readonly availableMemoryIds: ReadonlySet<string>,
        private readonly processedMemoryIds: Set<string>
    ) {
        super({ verboseParsingErrors: true })
    }

    async _call(input: z.infer<typeof memoryCheckedTool.schema>) {
        const memoryIds = [...new Set(input.memoryIds)]
        const unknownMemoryIds = memoryIds.filter(
            (id) => !this.availableMemoryIds.has(id)
        )
        if (unknownMemoryIds.length > 0) {
            throw new Error(
                `无法确认以下记忆的检查状态：${unknownMemoryIds.join('、')}。请核对记忆 ID 后重试。`
            )
        }

        for (const id of memoryIds) {
            this.processedMemoryIds.add(id)
        }

        return JSON.stringify(
            { checkedMemoryIds: memoryIds, reason: input.reason },
            null,
            2
        )
    }
}
