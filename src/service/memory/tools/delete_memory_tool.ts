import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'
import type { z } from 'zod'
import type { LivingMemoryArchiveProvider } from '../../../contracts/workflows'
import { LivingMemoryFactsCommittedError } from '../../vector_index/errors'
import { memoryDeleteTool } from '../../prompts/memory_tools'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId
} from './tool_runtime'

export class LivingMemoryDeleteMemoryTool extends StructuredTool {
    name = memoryDeleteTool.name
    description = memoryDeleteTool.description
    schema = memoryDeleteTool.schema

    constructor(private readonly archives: LivingMemoryArchiveProvider) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: z.infer<typeof memoryDeleteTool.schema>,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const resolution = resolveToolMemoryPresetId(
            getLivingMemoryToolConfigurable(runConfig)
        )
        if (resolution.ok === false) {
            throw new Error(
                describeLivingMemoryToolScopeFailure(resolution.reason)
            )
        }

        const warnings: string[] = []
        let deleted: boolean
        try {
            const result = await this.archives.archiveActiveMemories(
                resolution.presetId,
                [input.memoryId]
            )
            deleted = result.archived > 0
        } catch (error) {
            if (!(error instanceof LivingMemoryFactsCommittedError)) {
                throw error
            }
            deleted = true
            warnings.push(
                '记忆已归档，但向量索引同步失败，已调度后台自动对账：' +
                    error.message
            )
        }
        return JSON.stringify(
            { memoryId: input.memoryId, deleted, warnings },
            null,
            2
        )
    }
}
