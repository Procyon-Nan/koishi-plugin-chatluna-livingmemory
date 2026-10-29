import { StructuredTool } from '@langchain/core/tools'
import type { z } from 'zod'
import { memoryUpdateSnapshotTool } from '../../prompts/memory_tools'
import { MemoryInputError } from '../errors'

export class LivingMemoryUpdateSnapshotTool extends StructuredTool {
    name = memoryUpdateSnapshotTool.name
    description = memoryUpdateSnapshotTool.description
    schema = memoryUpdateSnapshotTool.schema

    constructor(
        private readonly lines: readonly string[],
        private readonly saveSnapshot: (text: string) => Promise<void>
    ) {
        super({ verboseParsingErrors: true })
    }

    async _call(input: z.infer<typeof memoryUpdateSnapshotTool.schema>) {
        const changes = new Map<number, string | null>()
        const additions: string[] = []

        for (const operation of input.operations) {
            if (operation.type === 'append') {
                additions.push(operation.text)
                continue
            }

            const { line } = operation
            if (line >= this.lines.length) {
                throw new MemoryInputError(
                    `行号 ${line} 超出旧快照的 ${this.lines.length} 行范围。`
                )
            }
            if (changes.has(line)) {
                throw new MemoryInputError(
                    `第 ${line} 行存在重复操作，请为该行提交一个操作。`
                )
            }
            changes.set(line, operation.type === 'delete' ? null : operation.text)
        }

        // 所有行号指向同一份旧快照，删除操作保持其余原行的编号稳定。
        const updatedLines = this.lines.flatMap((text, index) => {
            const change = changes.get(index)
            return change === null ? [] : [change ?? text]
        })
        const finalText = [...updatedLines, ...additions].join('\n')
        await this.saveSnapshot(finalText)
        return { lc_direct_tool_output: true as const, updated: true }
    }
}
