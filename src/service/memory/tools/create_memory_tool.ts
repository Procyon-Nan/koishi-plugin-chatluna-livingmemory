import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { z } from 'zod'
import type { LivingMemoryCreationProvider } from '../../../contracts/workflows'
import { LivingMemoryFactsCommittedError } from '../../vector_index/errors'
import {
    createLivingMemoryCreateInputSchema,
    livingMemoryCreateMemoryToolDescription,
    livingMemoryCreateMemoryToolName
} from './create_contract'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryScopeConfigurable
} from './tool_runtime'
import { resolveSpeakerKeysByLabels } from '../speaker_identity'

type LivingMemoryCreateMemoryToolInput = z.infer<
    ReturnType<typeof createLivingMemoryCreateInputSchema>
>

export class LivingMemoryCreateMemoryTool extends StructuredTool {
    name = livingMemoryCreateMemoryToolName
    description = livingMemoryCreateMemoryToolDescription
    schema: ReturnType<typeof createLivingMemoryCreateInputSchema>

    constructor(
        private readonly creation: LivingMemoryCreationProvider,
        maxMemories: number
    ) {
        super({ verboseParsingErrors: true })
        this.schema = createLivingMemoryCreateInputSchema(maxMemories)
    }

    async _call(
        input: LivingMemoryCreateMemoryToolInput,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const resolution = resolveToolMemoryScopeConfigurable(
            getLivingMemoryToolConfigurable(runConfig)
        )
        if (resolution.ok === false) {
            throw new Error(
                describeLivingMemoryToolScopeFailure(resolution.reason)
            )
        }

        const createdMemories: { id: string; type: string }[] = []
        const warnings: string[] = []
        const speakers = await this.creation.listPresetSpeakers(
            resolution.scope.presetId
        )
        const memories = input.memories.map((memory) => ({
            memory,
            speakerKeys: resolveSpeakerKeysByLabels(
                memory.speakerLabels,
                speakers
            )
        }))
        for (const { memory, speakerKeys } of memories) {
            try {
                // 非 strict 模式下 zod 推断字段为可选，运行时已由 schema
                // 硬校验保证完整；逐字段映射与 extraction extractor 的
                // 消费方式一致。
                const record = await this.creation.createMemory(
                    resolution.scope,
                    {
                        type: memory.type,
                        content: memory.content,
                        keywords: memory.keywords,
                        summary: memory.summary,
                        sentiment: memory.sentiment,
                        importance: memory.importance
                    },
                    speakerKeys
                )
                createdMemories.push({ id: record.id, type: record.type })
            } catch (error) {
                if (error instanceof LivingMemoryFactsCommittedError) {
                    // 事实已落库，仅索引同步失败：如实按已保存处理并附警告。
                    // 返回失败会诱导模型重试，产生重复记忆行。
                    warnings.push(
                        '记忆已保存，但向量索引同步失败，已调度后台自动对账：' +
                            error.message
                    )
                    continue
                }
                throw error
            }
        }

        return JSON.stringify({ createdMemories, warnings }, null, 2)
    }
}
