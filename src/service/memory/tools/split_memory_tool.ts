import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'
import type { z } from 'zod'
import type { LivingMemorySplitProvider } from '../../../contracts/workflows'
import { resolveSpeakerKeysByLabels } from '../speaker_identity'
import { memorySplitTool } from '../../prompts/memory_tools'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId
} from './tool_runtime'

export class LivingMemorySplitMemoryTool extends StructuredTool {
    name = memorySplitTool.name
    description = memorySplitTool.description
    schema = memorySplitTool.schema

    constructor(private readonly splits: LivingMemorySplitProvider) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: z.infer<typeof memorySplitTool.schema>,
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
        const speakers = await this.splits.listPresetSpeakers(
            resolution.presetId
        )
        const result = await this.splits.splitActiveMemory(
            resolution.presetId,
            input.sourceMemoryId,
            input.memories.map(({ speakerLabels, ...fields }) => ({
                ...fields,
                speakerKeys: resolveSpeakerKeysByLabels(speakerLabels, speakers)
            }))
        )
        return JSON.stringify(
            {
                memoryIds: result.memories.map((memory) => memory.id),
                archivedMemoryId: input.sourceMemoryId,
                split: true,
                warnings: result.warnings
            },
            null,
            2
        )
    }
}
