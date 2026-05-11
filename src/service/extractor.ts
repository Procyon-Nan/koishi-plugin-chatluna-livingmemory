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
    presetPrompt?: string | null
}

export class LivingMemoryExtractor {
    constructor(
        private readonly ctx: Context,
        private readonly extractModel: string
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
        const assistantLabel =
            context == null ? '当前 presetId 对应角色名' : context.presetId
        const taskPrompt = [
            '# 任务目标：',
            '你要以第一人称回顾并总结历史对话,生成符合你人格特色的记忆',
            '',
            '【历史对话】',
            '"""',
            input,
            '"""',
            '',
            '【任务要求】',
            '以第一人称回顾历史对话,总结你与对方的互动。用符合你人格设定的语气和视角来描述。重点关注:',
            '1. 对话主题: 你们讨论了什么',
            '2. 关键信息: 对方提到的重要事实(时间、地点、事件、需求等),必须关联到对方的具体昵称',
            `3. 你的参与: 特别注意标记为「${assistantLabel}:」的消息,这些是你自己的发言,务必在summary中体现`,
            '4. 互动情感: 对话的整体氛围',
            '5. 重要程度: 这段对话对未来交流的参考价值',
            '',
            '【记忆风格要求】',
            '总结时应体现你的人格特点,包括你的语气、用词习惯、关注点等,让记忆内容具有你的个性色彩',
            '如果你的人格设定是活泼可爱的助手,summary可能会是:"张三提醒我明天下午3点开会呀~要在会议室A老地方见,记得带项目文档!还让我帮忙约李经理,收到啦!"。如果你的人格设定是专业严谨的助手,summary可能会是:"接收到张三的会议通知:明日15:00于会议室A进行会议,需携带项目文档。已确认地点信息,并记录需协调李经理参会事宜。"',
            '',
            '【时间处理要求】',
            '将对话中出现的相对时间（如"今天"、"明天"、"昨天"、"下周"、"上个月"等）转换为具体日期后再写入记忆。',
            '',
            '【消息格式说明】',
            '对话历史中的每条消息都包含以下信息:',
            `- 以「${assistantLabel}:」开头的是你自己的发言；以「[昵称]说:」或「[id,昵称]说:」开头的是对方的发言。`,
            '',
            '【关键要求】',
            '- 在总结时,必须明确区分你说了什么和对方说了什么',
            '- 如果你参与了对话,务必在summary中体现你的回复内容和作用',
            '- summary必须使用第一人称视角,自然描述你与对方的互动,并体现你的人格特点',
            '- 必须使用具体的昵称:在summary和key_facts中,必须使用消息前缀中的具体昵称(如"Procyon"),绝对不能用"用户"、"对方"等泛化词汇替代',
            '- 记忆内容应符合你的人格设定:使用你的语气、关注点、表达习惯来描述记忆',
            '',
            '# 输出格式：',
            '你的输出必须是 JSON 数组，确保JSON格式正确可解析',
            '每个元素格式为 {"type":"identity|preference|fact|plan|context|other","content":"...","keywords":["..."],"summary":"..."}。',
            'content 应写成稳定、可复用的长期记忆，不要写成主题标签或关键词列表。',
            '只保留高价值、稳定、可复用的信息。',
            '如果没有可提取内容，输出 []。'
        ].join('\n')

        if (context == null) {
            return taskPrompt
        }

        const presetPrompt = context.presetPrompt?.trim()
        if (presetPrompt == null || presetPrompt.length === 0) {
            return taskPrompt
        }

        return [presetPrompt, '', taskPrompt].join('\n')
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
