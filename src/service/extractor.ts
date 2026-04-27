import { Context } from 'koishi'
import type { ExtractedMemoryItem } from '../types'

const normalizeText = (value: string) => value.trim()

const isModelConfigured = (model: string) => {
    return model.length > 0 && model !== '无'
}

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly extractModel: string,
        private readonly extractionPrompt: string
    ) {}

    async extract(input: string): Promise<ExtractedMemoryItem[]> {
        if (!isModelConfigured(this.extractModel)) {
            return []
        }

        const model = await this.ctx.chatluna.createChatModel(this.extractModel)
        if (model.value == null) {
            return []
        }

        const prompt = this.extractionPrompt + '\n\n' + input

        const result = await model.value.invoke(prompt)
        const content =
            typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content)

        return this.parse(content)
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
