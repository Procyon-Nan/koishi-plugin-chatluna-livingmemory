import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'
import type { z } from 'zod'
import type { LivingMemoryUpdateProvider } from '../../../contracts/workflows'
import { LivingMemoryFactsCommittedError } from '../../vector_index/errors'
import { resolveSpeakerKeysByLabels } from '../speaker_identity'
import { memoryUpdateTool } from '../../prompts/memory_tools'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId
} from './tool_runtime'

export class LivingMemoryUpdateMemoryTool extends StructuredTool {
    name = memoryUpdateTool.name
    description = memoryUpdateTool.description
    schema = memoryUpdateTool.schema

    constructor(private readonly updates: LivingMemoryUpdateProvider) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: z.infer<typeof memoryUpdateTool.schema>,
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

        const speakers = await this.updates.listPresetSpeakers(
            resolution.presetId
        )
        const { memory, memoryId } = input
        const speakerKeys = resolveSpeakerKeysByLabels(
            memory.speakerLabels,
            speakers
        )
        const warnings: string[] = []
        try {
            const record = await this.updates.updateActiveMemory(
                resolution.presetId,
                memoryId,
                {
                    type: memory.type,
                    content: memory.content,
                    keywords: memory.keywords,
                    summary: memory.summary,
                    sentiment: memory.sentiment,
                    importance: memory.importance,
                    speakerKeys
                }
            )
            if (record === null) {
                throw new Error(
                    '当前预设中不存在该活跃记忆，请重新检索后再更新。'
                )
            }
        } catch (error) {
            if (!(error instanceof LivingMemoryFactsCommittedError)) {
                throw error
            }
            warnings.push(
                '记忆已更新，但向量索引同步失败，已调度后台自动对账：' +
                    error.message
            )
        }
        return JSON.stringify({ memoryId, updated: true, warnings }, null, 2)
    }
}
