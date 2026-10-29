import { StructuredTool } from '@langchain/core/tools'
import { memoryPassTool } from '../../prompts/memory_tools'

export class LivingMemoryPassTool extends StructuredTool {
    name = memoryPassTool.name
    description = memoryPassTool.description
    schema = memoryPassTool.schema

    async _call() {
        return { lc_direct_tool_output: true as const, updated: false }
    }
}
