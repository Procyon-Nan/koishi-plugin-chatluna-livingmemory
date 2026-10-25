import { Context } from 'koishi'
import type { AttributedMemoryItem } from '../../../contracts/workflows'
import { isModelConfigured } from '../../shared/utils'
import {
    extractionResultSchema,
    extractionResultToolName
} from '../../prompts/schema'
import { buildExtractionPrompts } from '../../prompts/extraction'
import type { PromptMessages } from '../../prompts/prompt_format'
import { normalizeMemoryKeywords } from '../../memory/entry_fields'
import { invokeStructuredOutput } from '../structured_output'
import { resolveScopeAssistantLabel } from '../../memory/helpers'
import type { LivingMemoryLogger } from '../../logging/logger'
import { resolveSpeakerKeysByLabels } from '../../memory/speaker_identity'

export type LivingMemoryExtractionSkipReason =
    | 'model-not-configured'
    | 'model-unavailable'

export interface LivingMemoryExtractionResult {
    extracted: AttributedMemoryItem[]
    prompt: PromptMessages | null
    output: string | null
    skippedReason: LivingMemoryExtractionSkipReason | null
    // 结果工具调用或参数无法通过 Schema 校验时的原因。为 null 表示成功，
    // 包括模型通过工具提交空 memories 数组并说明原因。
    parseError: string | null
}

export interface LivingMemoryExtractionContext {
    conversationId: string
    presetId: string
    presetLabel?: string
    presetPrompt: string
    speakers: Array<{
        speakerLabel: string
        speakerKey: string
    }>
}

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly mainModel: string
    ) {}

    async extract(
        input: string,
        context: LivingMemoryExtractionContext,
        logger: LivingMemoryLogger
    ): Promise<LivingMemoryExtractionResult> {
        if (!isModelConfigured(this.mainModel)) {
            return {
                extracted: [],
                prompt: null,
                output: null,
                skippedReason: 'model-not-configured',
                parseError: null
            }
        }

        const model = await this.ctx.chatluna.createChatModel(this.mainModel)
        if (model.value == null) {
            return {
                extracted: [],
                prompt: null,
                output: null,
                skippedReason: 'model-unavailable',
                parseError: null
            }
        }

        const prompt = this.buildPrompt(input, context)
        const result = await invokeStructuredOutput({
            model: model.value,
            prompt,
            toolName: extractionResultToolName,
            toolDescription:
                '提交本次记录的长期记忆及理由。没有可记录的记忆时提交空 memories 数组，并说明原因。',
            schema: extractionResultSchema,
            validateResult: ({ memories }) => {
                for (const memory of memories) {
                    resolveSpeakerKeysByLabels(
                        memory.speakerLabels,
                        context.speakers
                    )
                }
            },
            stringifiedArrayField: 'memories',
            context: {
                presetId: context.presetId,
                conversationId: context.conversationId
            },
            logging: { logger, stage: 'memory-extraction' }
        })
        if (result.value != null) {
            logger.diagnostic('extraction.result', {
                extracted: result.value.memories.length,
                reason: result.value.reason
            })
        }
        const extracted =
            result.value?.memories.map((item): AttributedMemoryItem => {
                return {
                    type: item.type,
                    content: item.content,
                    summary: item.summary,
                    keywords: normalizeMemoryKeywords(item.keywords),
                    sentiment: item.sentiment,
                    importance: item.importance,
                    speakerKeys: resolveSpeakerKeysByLabels(
                        item.speakerLabels,
                        context.speakers
                    )
                }
            }) ?? []

        return {
            extracted,
            prompt,
            output: result.output,
            skippedReason: null,
            parseError: result.parseError
        }
    }

    private buildPrompt(input: string, context: LivingMemoryExtractionContext) {
        const assistantLabel = resolveScopeAssistantLabel(context)

        return buildExtractionPrompts({
            chatHistory: input,
            assistantLabel,
            presetPrompt: context.presetPrompt
        })
    }
}
