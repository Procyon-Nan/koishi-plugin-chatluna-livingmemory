import { Context } from 'koishi'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { ExtractedMemoryItem } from '../../../contracts/workflows'
import {
    isModelConfigured,
    stringifyModelContent,
    summarizeError
} from '../../shared/utils'
import { buildExtractionPrompt } from '../../prompts'
import type { ExtractionPromptMessages } from '../../prompts'
import {
    DEFAULT_MEMORY_IMPORTANCE,
    normalizeMemoryImportance,
    normalizeMemoryKeywords,
    normalizeMemoryText,
    normalizeOptionalMemoryText
} from '../../memory/entry_fields'

export type LivingMemoryExtractionSkipReason =
    | 'model-not-configured'
    | 'model-unavailable'

export interface LivingMemoryExtractionTrace {
    extracted: ExtractedMemoryItem[]
    prompt: string | null
    output: string | null
    skippedReason: LivingMemoryExtractionSkipReason | null
    // 模型输出无法解析为合法 JSON 数组时的原因。为 null 表示解析成功
    // （含模型合法返回空数组）。用于区分“无可抽取内容”与“解析失败”，
    // 使作业状态如实反映，而非一律标记为成功。
    parseError: string | null
}

export interface LivingMemoryExtractionContext {
    conversationId: string
    presetId: string
    presetLabel?: string
    presetPrompt?: string | null
}

const formatPromptTrace = (prompt: ExtractionPromptMessages) => {
    return [
        '[system]',
        prompt.systemPrompt,
        '',
        '[human]',
        prompt.inputPrompt
    ].join('\n')
}

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly extractModel: string
    ) {}

    async extractWithTrace(
        input: string,
        context?: LivingMemoryExtractionContext
    ): Promise<LivingMemoryExtractionTrace> {
        if (!isModelConfigured(this.extractModel)) {
            return {
                extracted: [],
                prompt: null,
                output: null,
                skippedReason: 'model-not-configured',
                parseError: null
            }
        }

        const model = await this.ctx.chatluna.createChatModel(this.extractModel)
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

        const result = await model.value.invoke([
            new SystemMessage(prompt.systemPrompt),
            new HumanMessage(prompt.inputPrompt)
        ])
        const content = stringifyModelContent(result.content)

        const { extracted, parseError } = this.parse(content)

        return {
            extracted,
            prompt: formatPromptTrace(prompt),
            output: content,
            skippedReason: null,
            parseError
        }
    }

    private parse(content: string): {
        extracted: ExtractedMemoryItem[]
        parseError: string | null
    } {
        const normalized = content.trim()
        if (normalized.length === 0) {
            return { extracted: [], parseError: 'empty model output' }
        }

        const firstBracket = normalized.indexOf('[')
        const lastBracket = normalized.lastIndexOf(']')
        if (firstBracket < 0 || lastBracket < firstBracket) {
            return {
                extracted: [],
                parseError: 'no JSON array delimiters found'
            }
        }

        const raw = normalized.slice(firstBracket, lastBracket + 1)
        let parsed: unknown

        try {
            parsed = JSON.parse(raw)
        } catch (error) {
            return { extracted: [], parseError: summarizeError(error) }
        }

        if (!Array.isArray(parsed)) {
            return { extracted: [], parseError: 'parsed value is not an array' }
        }

        const extracted = parsed
            .map((item) => {
                if (item == null || typeof item !== 'object') {
                    return null
                }

                const record = item as Record<string, unknown>
                const content =
                    typeof record.content === 'string'
                        ? normalizeMemoryText(record.content)
                        : ''
                const type =
                    typeof record.type === 'string' ? record.type : 'other'
                const summary =
                    typeof record.summary === 'string'
                        ? normalizeOptionalMemoryText(record.summary)
                        : null
                const sentiment =
                    typeof record.sentiment === 'string'
                        ? normalizeOptionalMemoryText(record.sentiment)
                        : null
                const keywords = Array.isArray(record.keywords)
                    ? normalizeMemoryKeywords(record.keywords)
                    : undefined

                if (content.length === 0) {
                    return null
                }

                return {
                    type: this.normalizeMemoryType(type),
                    content,
                    keywords,
                    summary,
                    sentiment,
                    importance:
                        normalizeMemoryImportance(record.importance) ??
                        DEFAULT_MEMORY_IMPORTANCE
                }
            })
            .filter((item): item is NonNullable<typeof item> => item != null)

        return { extracted, parseError: null }
    }

    private buildPrompt(
        input: string,
        context?: LivingMemoryExtractionContext
    ) {
        const assistantLabel =
            context == null
                ? '当前 presetId 对应角色名'
                : context.presetLabel?.trim() || context.presetId

        return buildExtractionPrompt({
            input,
            assistantLabel,
            presetPrompt: context?.presetPrompt
        })
    }

    private normalizeMemoryType(type: string): ExtractedMemoryItem['type'] {
        switch (type) {
            case 'identity':
            case 'preference':
            case 'fact':
            case 'plan':
            case 'context':
            case 'other':
                return type
            default:
                return 'other'
        }
    }
}
