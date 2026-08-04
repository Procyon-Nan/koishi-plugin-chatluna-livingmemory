import { Context } from 'koishi'
import type { ExtractedMemoryItem } from '../../../contracts/workflows'
import { isModelConfigured } from '../../shared/utils'
import {
    buildExtractionPrompt,
    extractionResultSchema,
    extractionResultToolDescription,
    extractionResultToolName
} from '../../prompts'
import { formatPromptMessagesTrace } from '../../prompts/prompt_format'
import {
    normalizeMemoryKeywords,
    normalizeMemoryText
} from '../../memory/entry_fields'
import { invokeStructuredOutput } from '../structured_output'

export type LivingMemoryExtractionSkipReason =
    | 'model-not-configured'
    | 'model-unavailable'

export interface LivingMemoryExtractionTrace {
    extracted: ExtractedMemoryItem[]
    prompt: string | null
    output: string | null
    skippedReason: LivingMemoryExtractionSkipReason | null
    // 结果工具调用或参数无法通过 Schema 校验时的原因。为 null 表示成功，
    // 包括模型通过工具合法提交空 memories 数组。
    parseError: string | null
}

export interface LivingMemoryExtractionContext {
    conversationId: string
    presetId: string
    presetLabel?: string
    presetPrompt: string
}

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly mainModel: string
    ) {}

    async extractWithTrace(
        input: string,
        context: LivingMemoryExtractionContext
    ): Promise<LivingMemoryExtractionTrace> {
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
            toolDescription: extractionResultToolDescription,
            schema: extractionResultSchema,
            stringifiedArrayField: 'memories',
            context: {
                presetId: context.presetId,
                conversationId: context.conversationId
            }
        })
        const extracted =
            result.value?.memories.map((item): ExtractedMemoryItem => {
                return {
                    type: item.type,
                    content: normalizeMemoryText(item.content),
                    summary: normalizeMemoryText(item.summary),
                    keywords: normalizeMemoryKeywords(item.keywords),
                    sentiment: normalizeMemoryText(item.sentiment),
                    importance: item.importance
                }
            }) ?? []

        return {
            extracted,
            prompt: formatPromptMessagesTrace(prompt),
            output: result.output,
            skippedReason: null,
            parseError: result.parseError
        }
    }

    private buildPrompt(input: string, context: LivingMemoryExtractionContext) {
        const assistantLabel = context.presetLabel?.trim() || context.presetId

        return buildExtractionPrompt({
            input,
            assistantLabel,
            presetPrompt: context.presetPrompt
        })
    }
}
