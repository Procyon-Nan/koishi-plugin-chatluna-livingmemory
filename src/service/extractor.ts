import { Context } from 'koishi'
import type { ExtractedMemoryItem } from '../types'
import {
    isModelConfigured,
    stringifyModelContent,
    summarizeError
} from './shared/utils'
import { buildExtractionPrompt } from './prompts'

const normalizeText = (value: string) => value.trim()

const DEFAULT_IMPORTANCE = 0.5

const parseImportance = (value: unknown) => {
    const importance =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim().length > 0
              ? Number(value.trim())
              : Number.NaN

    if (!Number.isFinite(importance)) {
        return DEFAULT_IMPORTANCE
    }

    return Math.min(1, Math.max(0, importance))
}

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

        const result = await model.value.invoke(prompt)
        const content = stringifyModelContent(result.content)

        const { extracted, parseError } = this.parse(content)

        return {
            extracted,
            prompt,
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
                        ? normalizeText(record.content)
                        : ''
                const type =
                    typeof record.type === 'string' ? record.type : 'other'
                const summary =
                    typeof record.summary === 'string'
                        ? normalizeText(record.summary)
                        : null
                const sentiment =
                    typeof record.sentiment === 'string'
                        ? normalizeText(record.sentiment)
                        : null
                const keywords = Array.isArray(record.keywords)
                    ? record.keywords.filter(
                          (keyword): keyword is string =>
                              typeof keyword === 'string'
                      )
                    : undefined

                if (content.length === 0) {
                    return null
                }

                return {
                    type: this.normalizeMemoryType(type),
                    content,
                    keywords,
                    summary: summary?.length ? summary : null,
                    sentiment: sentiment?.length ? sentiment : null,
                    importance: parseImportance(record.importance)
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
