import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'
import type { z } from 'zod'
import type { LivingMemoryMergeProvider } from '../../../contracts/workflows'
import { resolveSpeakerKeysByLabels } from '../speaker_identity'
import { memoryMergeTool } from '../../prompts/memory_tools'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId
} from './tool_runtime'

export class LivingMemoryMergeMemoriesTool extends StructuredTool {
    name = memoryMergeTool.name
    description = memoryMergeTool.description
    schema = memoryMergeTool.schema

    constructor(private readonly merges: LivingMemoryMergeProvider) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: z.infer<typeof memoryMergeTool.schema>,
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

        const speakers = await this.merges.listPresetSpeakers(
            resolution.presetId
        )
        const { sourceMemoryIds, memory } = input
        const { speakerLabels, ...fields } = memory
        const speakerKeys = resolveSpeakerKeysByLabels(speakerLabels, speakers)
        const result = await this.merges.mergeActiveMemories(
            resolution.presetId,
            sourceMemoryIds,
            { ...fields, speakerKeys }
        )
        return JSON.stringify(
            {
                memoryId: result.memory.id,
                archivedMemoryIds: sourceMemoryIds,
                merged: true,
                warnings: result.warnings
            },
            null,
            2
        )
    }
}
