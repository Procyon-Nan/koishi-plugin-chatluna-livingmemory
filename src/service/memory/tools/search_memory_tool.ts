import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { z } from 'zod'
import type { LivingMemorySearchResult } from '../../../contracts/memory'
import type { LivingMemorySearchProvider } from '../../../contracts/workflows'
import {
    contextMemoryFields,
    renderMemoriesForModel,
    searchMemoryFields
} from '../../prompts/memory_entries'
import { memorySearchTool } from '../../prompts/memory_tools'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId,
    resolveToolMemoryScopeConfigurable
} from './tool_runtime'
const noMemoryFoundMessage = '没有找到相关记忆。'

export class LivingMemorySearchTool extends StructuredTool {
    name = memorySearchTool.name

    schema = memorySearchTool.schema
    description = memorySearchTool.description

    constructor(
        private readonly searchProvider: LivingMemorySearchProvider,
        private readonly includeMemoryIds: boolean,
        private readonly enableConversationIsolation = false
    ) {
        super({ verboseParsingErrors: true })
    }

    async runSearch(
        input: z.infer<typeof memorySearchTool.schema>,
        runConfig?: ToolRunnableConfig
    ): Promise<{ results: LivingMemorySearchResult[]; output: string }> {
        const configurable = getLivingMemoryToolConfigurable(runConfig)
        let presetId: string
        let conversationId: string | undefined
        if (this.enableConversationIsolation) {
            const resolution = resolveToolMemoryScopeConfigurable(configurable)
            if (resolution.ok === false) {
                throw new Error(
                    describeLivingMemoryToolScopeFailure(resolution.reason)
                )
            }
            presetId = resolution.scope.presetId
            conversationId = resolution.scope.conversationId
        } else {
            const presetIdResolution = resolveToolMemoryPresetId(configurable)
            if (presetIdResolution.ok === false) {
                throw new Error(
                    describeLivingMemoryToolScopeFailure(
                        presetIdResolution.reason
                    )
                )
            }
            presetId = presetIdResolution.presetId
        }

        const results = await this.searchProvider.searchMemories(
            presetId,
            { ...input, memoryTypes: ['all'], memoryStatus: 'active' },
            conversationId
        )

        return { results, output: this.formatResults(results) }
    }

    async _call(
        input: z.infer<typeof memorySearchTool.schema>,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const { output } = await this.runSearch(input, runConfig)
        return output
    }

    private formatResults(results: LivingMemorySearchResult[]) {
        if (results.length === 0) {
            return noMemoryFoundMessage
        }

        return renderMemoriesForModel(results, {
            fields: this.includeMemoryIds
                ? searchMemoryFields
                : contextMemoryFields
        })
    }
}
