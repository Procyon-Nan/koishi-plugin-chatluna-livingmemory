import { Context } from 'koishi'
import type { ExtractedMemoryItem } from '../types'

const normalizeText = (value: string) => value.trim()

const DEFAULT_IMPORTANCE = 0.5

const isModelConfigured = (model: string) => {
    return model.length > 0 && model !== '无'
}

const stringifyModelContent = (content: unknown) => {
    if (typeof content === 'string') {
        return content
    }

    return JSON.stringify(content) ?? ''
}

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
            '你要回顾历史对话,总结你与对方的互动。用符合你人格设定的语气和视角来描述。重点关注:',
            '1. 对话主题: 你们讨论了什么',
            '2. 关键信息: 对方提到的重要事实(时间、地点、事件、需求等),必须关联到对方的具体昵称',
            `3. 你的参与: 特别注意标记为「${assistantLabel}:」的消息,这些是你自己的发言,务必在content中体现`,
            '4. 互动情感: 对话的整体氛围',
            '5. 重要程度: 这段对话对未来交流的参考价值',
            '',
            '【记忆风格要求】',
            'content 是最终注入给你的长期记忆正文,应体现你的人格特点、语气、关注点和关系视角，口语化描述，带有人性化特征',
            'summary 是用于检索召回的压缩语义摘要,应简短、清晰、准确,避免颜文字、口癖、过度角色语气和长句。',
            'keywords 是用于检索的关键词锚点,应保留具体昵称、状态、动作、关系和事件关键词。',
            'sentiment 是这条记忆的简短情绪色彩,可以自由使用类似"担心"、"亲近"、"愉快"、"疲惫"、"中性"这样的词。',
            'importance 是 0 到 1 之间的数字,表示这条记忆对长期陪伴连续性的价值,越高越应该在未来 Dream 整理时保留或优先考虑。',
            '好的content示例:"Procyon眼周充血时仍不太有危机感,我需要更主动地提醒他休息,并引导他按摩太阳穴和眉心放松眼睛。"',
            '好的summary示例:"Procyon眼周充血,需要我提醒休息并引导眼部放松"',
            '好的sentiment示例:"担心"',
            '好的importance示例:0.82',
            '不推荐的summary示例:"Procyon这孩子居然觉得眼周充血是常事,真是无可救药..."',
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
            '- 如果你参与了对话,务必在content中体现你的回复内容和作用',
            '- content必须使用第一人称视角,其中"我"指当前preset角色,自然描述你与具体昵称对象之间的互动、关系、事实或偏好',
            '- summary必须服务于检索召回,不要写成角色台词、吐槽、抒情句或人格化短文',
            '- sentiment必须简短,只描述情绪色彩,不要写成长句',
            '- importance必须是数字,范围为0到1;日常闲聊但有关系连续性价值可给0.4到0.7,明确身份、偏好、关系、健康、计划等长期信息可给0.7到1',
            '- 必须使用具体的昵称:在content、summary和keywords中,必须使用消息前缀中的具体昵称(如"Procyon"),绝对不能用"用户"、"对方"等泛化词汇替代',
            '- 记忆内容应符合字段职责:content用于长期注入,summary用于辅助检索,keywords用于精确锚点,sentiment用于记录情绪色彩,importance用于后续Dream整理权重',
            '',
            '# 输出格式：',
            '你的输出必须是 JSON 数组，确保JSON格式正确可解析',
            '每个元素格式为 {"type":"identity|preference|fact|plan|context|other","content":"...","keywords":["..."],"summary":"...","sentiment":"...","importance":0.5}。',
            'content 应写成稳定、可复用、第一人称的长期记忆正文,不要写成主题标签或关键词列表。',
            'summary 应写成检索友好的短摘要,用于帮助之后召回这条记忆。',
            'keywords 应写成短词数组,用于补充实体、状态、动作、关系和事件锚点。',
            'sentiment 应写成简短自由文本,没有明显情绪时可写"中性"。',
            'importance 应写成 0 到 1 之间的数字。',
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
