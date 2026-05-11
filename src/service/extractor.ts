import { Context } from 'koishi'
import type { ExtractedMemoryItem } from '../types'

const normalizeText = (value: string) => value.trim()

const isModelConfigured = (model: string) => {
    return model.length > 0 && model !== '无'
}

const stringifyModelContent = (content: unknown) => {
    if (typeof content === 'string') {
        return content
    }

    return JSON.stringify(content) ?? ''
}

export type LivingMemoryExtractionSkipReason =
    | 'model-not-configured'
    | 'model-unavailable'

export interface LivingMemoryExtractionTrace {
    extracted: ExtractedMemoryItem[]
    prompt: string | null
    output: string | null
    skippedReason: LivingMemoryExtractionSkipReason | null
}

export interface LivingMemoryExtractionContext {
    conversationId: string
    presetId: string
}

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly extractModel: string,
        private readonly extractionPrompt: string
    ) {}

    async extract(input: string): Promise<ExtractedMemoryItem[]> {
        const trace = await this.extractWithTrace(input)
        return trace.extracted
    }

    async extractWithTrace(
        input: string,
        context?: LivingMemoryExtractionContext
    ): Promise<LivingMemoryExtractionTrace> {
        if (!isModelConfigured(this.extractModel)) {
            return {
                extracted: [],
                prompt: null,
                output: null,
                skippedReason: 'model-not-configured'
            }
        }

        const model = await this.ctx.chatluna.createChatModel(this.extractModel)
        if (model.value == null) {
            return {
                extracted: [],
                prompt: null,
                output: null,
                skippedReason: 'model-unavailable'
            }
        }

        const prompt = this.buildPrompt(input, context)

        const result = await model.value.invoke(prompt)
        const content = stringifyModelContent(result.content)

        return {
            extracted: this.parse(content),
            prompt,
            output: content,
            skippedReason: null
        }
    }

    private parse(content: string): ExtractedMemoryItem[] {
        const normalized = content.trim()
        if (normalized.length === 0) {
            return []
        }

        const firstBracket = normalized.indexOf('[')
        const lastBracket = normalized.lastIndexOf(']')
        if (firstBracket < 0 || lastBracket < firstBracket) {
            return []
        }

        const raw = normalized.slice(firstBracket, lastBracket + 1)
        let parsed: unknown

        try {
            parsed = JSON.parse(raw)
        } catch {
            return []
        }

        if (!Array.isArray(parsed)) {
            return []
        }

        return parsed
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
                    summary: summary?.length ? summary : null
                }
            })
            .filter((item): item is NonNullable<typeof item> => item != null)
    }

    private buildPrompt(input: string, context?: LivingMemoryExtractionContext) {
        if (context == null) {
            return this.extractionPrompt + '\n\n' + input
        }

        return [
            `conversationId=${context.conversationId}`,
            `presetId=${context.presetId}`,
            '',
            this.extractionPrompt,
            '',
            input
        ].join('\n')
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
