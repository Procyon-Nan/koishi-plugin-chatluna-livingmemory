import { Context } from 'koishi'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { memoryEntryTypes } from '../../../contracts/memory'
import type { ExtractedMemoryItem } from '../../../contracts/workflows'
import {
    isModelConfigured,
    stringifyModelContent,
    summarizeError
} from '../../shared/utils'
import { buildExtractionPrompt } from '../../prompts'
import { formatPromptMessagesTrace } from '../../prompts/prompt_format'
import {
    MAX_MEMORY_KEYWORDS,
    normalizeMemoryKeywords,
    normalizeMemoryText
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

type ParsedExtractionItem =
    | { value: ExtractedMemoryItem; parseError: null }
    | { value: null; parseError: string }

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly extractModel: string
    ) {}

    async extractWithTrace(
        input: string,
        context: LivingMemoryExtractionContext
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
            prompt: formatPromptMessagesTrace(prompt),
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

        const extracted: ExtractedMemoryItem[] = []
        for (const [index, item] of parsed.entries()) {
            const result = this.parseItem(item, index)
            if (result.parseError != null) {
                return {
                    extracted: [],
                    parseError: result.parseError
                }
            }

            extracted.push(result.value)
        }

        return { extracted, parseError: null }
    }

    private parseItem(item: unknown, index: number): ParsedExtractionItem {
        if (item == null || typeof item !== 'object' || Array.isArray(item)) {
            return this.invalidItem(index, 'object')
        }

        const record = item as Record<string, unknown>
        if (!this.isMemoryEntryType(record.type)) {
            return this.invalidItem(index, 'type')
        }

        const content = normalizeMemoryText(record.content)
        if (typeof record.content !== 'string' || content.length === 0) {
            return this.invalidItem(index, 'content')
        }

        const summary = normalizeMemoryText(record.summary)
        if (typeof record.summary !== 'string' || summary.length === 0) {
            return this.invalidItem(index, 'summary')
        }

        if (
            !Array.isArray(record.keywords) ||
            record.keywords.length > MAX_MEMORY_KEYWORDS ||
            record.keywords.some(
                (keyword) =>
                    typeof keyword !== 'string' ||
                    normalizeMemoryText(keyword).length === 0
            )
        ) {
            return this.invalidItem(index, 'keywords')
        }
        const keywords = normalizeMemoryKeywords(record.keywords)

        const sentiment = normalizeMemoryText(record.sentiment)
        if (typeof record.sentiment !== 'string' || sentiment.length === 0) {
            return this.invalidItem(index, 'sentiment')
        }

        if (
            typeof record.importance !== 'number' ||
            !Number.isFinite(record.importance) ||
            record.importance < 0 ||
            record.importance > 1
        ) {
            return this.invalidItem(index, 'importance')
        }

        return {
            value: {
                type: record.type,
                content,
                summary,
                keywords,
                sentiment,
                importance: record.importance
            },
            parseError: null
        }
    }

    private isMemoryEntryType(
        value: unknown
    ): value is ExtractedMemoryItem['type'] {
        return (
            typeof value === 'string' &&
            (memoryEntryTypes as readonly string[]).includes(value)
        )
    }

    private invalidItem(index: number, field: string): ParsedExtractionItem {
        return {
            value: null,
            parseError: `item ${index} has missing or invalid ${field}`
        }
    }

    private buildPrompt(input: string, context: LivingMemoryExtractionContext) {
        const assistantLabel = context.presetLabel?.trim() || context.presetId

        return buildExtractionPrompt({
            input,
            presetId: context.presetId,
            assistantLabel,
            presetPrompt: context.presetPrompt
        })
    }
}
