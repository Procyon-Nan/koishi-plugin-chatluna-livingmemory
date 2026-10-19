import { StructuredTool } from '@langchain/core/tools'
import type { z } from 'zod'
import { memoryCheckedTool } from '../../prompts/memory_tools'

type MemoryCheckHandler = (
    input: z.infer<typeof memoryCheckedTool.schema>
) => Promise<{ warnings: string[] }>

export class LivingMemoryCheckedMemoryTool extends StructuredTool {
    name = memoryCheckedTool.name
    description = memoryCheckedTool.description
    schema = memoryCheckedTool.schema

    constructor(private readonly checkMemories: MemoryCheckHandler) {
        super({ verboseParsingErrors: true })
    }

    async _call(input: z.infer<typeof memoryCheckedTool.schema>) {
        const memoryIds = [...new Set(input.memoryIds)]
        const { warnings } = await this.checkMemories({
            memoryIds,
            reason: input.reason
        })

        return JSON.stringify(
            { checkedMemoryIds: memoryIds, reason: input.reason, warnings },
            null,
            2
        )
    }
}
