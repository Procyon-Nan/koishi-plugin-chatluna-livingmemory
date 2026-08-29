import { Context } from 'koishi'
import type { AttributedMemoryItem } from '../../../contracts/workflows'
import { isModelConfigured } from '../../shared/utils'
import {
    buildExtractionPrompt,
    createExtractionResultSchema,
    extractionResultToolDescription,
    extractionResultToolName
} from '../../prompts'
import type { PromptMessages } from '../../prompts/prompt_format'
import {
    normalizeMemoryKeywords,
    normalizeMemoryText
} from '../../memory/entry_fields'
import { invokeStructuredOutput } from '../structured_output'
import { resolveScopeAssistantLabel } from '../../memory/helpers'
import type { LivingMemoryLogger } from '../../logging/logger'
import { normalizeSpeakerKeys } from '../../memory/speaker_identity'

export type LivingMemoryExtractionSkipReason =
    | 'model-not-configured'
    | 'model-unavailable'

export interface LivingMemoryExtractionTrace {
    extracted: AttributedMemoryItem[]
    prompt: PromptMessages | null
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

    async extractWithTrace(
        input: string,
        context: LivingMemoryExtractionContext,
        logger?: LivingMemoryLogger
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
            schema: createExtractionResultSchema(
                context.speakers.map((speaker) => speaker.speakerLabel)
            ),
            stringifiedArrayField: 'memories',
            context: {
                presetId: context.presetId,
                conversationId: context.conversationId
            },
            logging:
                logger == null
                    ? undefined
                    : {
                          logger,
                          workflow: 'extraction',
                          stage: 'memory-extraction'
                      }
        })
        const speakerKeyByLabel = new Map(
            context.speakers.map((speaker) => [
                speaker.speakerLabel,
                speaker.speakerKey
            ])
        )
        const onlySpeakerKey =
            context.speakers.length === 1
                ? context.speakers[0].speakerKey
                : undefined
        const extracted =
            result.value?.memories.map((item): AttributedMemoryItem => {
                return {
                    type: item.type,
                    content: normalizeMemoryText(item.content),
                    summary: normalizeMemoryText(item.summary),
                    keywords: normalizeMemoryKeywords(item.keywords),
                    sentiment: normalizeMemoryText(item.sentiment),
                    importance: item.importance,
                    speakerKeys: normalizeSpeakerKeys(
                        onlySpeakerKey == null
                            ? item.speakerLabels.map((label) =>
                                  speakerKeyByLabel.get(label)!
                              )
                            : [onlySpeakerKey]
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

        return buildExtractionPrompt({
            input,
            assistantLabel,
            presetPrompt: context.presetPrompt
        })
    }
}
