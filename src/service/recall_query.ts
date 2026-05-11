import type { BaseMessage } from '@langchain/core/messages'
import { Context } from 'koishi'
import { LivingMemoryMessageFormatter } from './message_formatter'
import type { LivingMemoryConfig, MemoryScope } from '../types'

const isModelConfigured = (model: string) => {
    return model.length > 0 && model !== '无'
}

const semanticTextPattern = /[\p{L}\p{N}]/u
const prefixedSpeakerPattern = /^\[[^\]]+\]说:\s*/u

const toTextParts = (message: BaseMessage) => {
    const rawContent = message.additional_kwargs?.raw_content
    if (typeof rawContent === 'string' && rawContent.length > 0) {
        return [rawContent]
    }

    if (typeof message.content === 'string') {
        return [message.content]
    }

    if (!Array.isArray(message.content)) {
        return []
    }

    return message.content
        .map((part) => {
            if (
                part != null &&
                typeof part === 'object' &&
                (part as Record<string, unknown>).type === 'text' &&
                typeof (part as Record<string, unknown>).text === 'string'
            ) {
                return (part as { text: string }).text
            }

            return null
        })
        .filter((part): part is string => part != null)
}

const toCleanLines = (parts: string[]) => {
    return parts
        .flatMap((part) => part.replace(/\r\n/g, '\n').split('\n'))
        .map((line) => line.replace(prefixedSpeakerPattern, '').trim())
        .filter((line) => line.length > 0 && semanticTextPattern.test(line))
}

const stringifyModelContent = (content: unknown) => {
    if (typeof content === 'string') {
        return content
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (
                    part != null &&
                    typeof part === 'object' &&
                    (part as Record<string, unknown>).type === 'text' &&
                    typeof (part as Record<string, unknown>).text === 'string'
                ) {
                    return (part as { text: string }).text
                }

                return ''
            })
            .join('')
    }

    return JSON.stringify(content) ?? ''
}

const summarizeError = (error: unknown) => {
    if (error instanceof Error) {
        return error.stack ?? error.message
    }

    if (typeof error === 'string') {
        return error
    }

    return JSON.stringify(error)
}

const stripFencedBlock = (value: string) => {
    return value
        .replace(/^```(?:\w+)?\s*/u, '')
        .replace(/\s*```$/u, '')
        .trim()
}

const normalizeRewriteOutput = (output: string) => {
    const normalized = stripFencedBlock(output)
    const firstLine = normalized
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.length > 0)

    if (firstLine == null) {
        return ''
    }

    return firstLine
        .replace(/^(?:query|search query|查询|检索查询|最终查询)[:：]\s*/iu, '')
        .replace(/^["'“”]+|["'“”]+$/gu, '')
        .trim()
}

const isSkipQuery = (query: string) => {
    return query.trim().toLowerCase() === '[skip]'
}

export type RecallQueryFallbackReason =
    | 'rewrite-disabled'
    | 'model-not-configured'
    | 'model-unavailable'
    | 'model-skip'
    | 'empty-output'
    | 'invalid-output'
    | 'invoke-failed'

export interface RecallQueryResult {
    rawInput: string
    rawInputLength: number
    cleanedQuery: string
    finalQuery: string
    rewritePrompt: string | null
    rewriteOutput: string | null
    fallbackReason: RecallQueryFallbackReason | null
    skippedReason: 'empty-cleaned-query' | null
    error: string | null
}

export class LivingMemoryRecallQueryBuilder {
    private readonly formatter = new LivingMemoryMessageFormatter()

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig
    ) {}

    async resolve(
        scope: MemoryScope,
        currentMessage: BaseMessage,
        historyMessages: BaseMessage[]
    ): Promise<RecallQueryResult> {
        const rawParts = toTextParts(currentMessage)
        const rawInput = rawParts.join('\n')
        const cleanedQuery = toCleanLines(rawParts).join('\n')

        if (cleanedQuery.length === 0) {
            return {
                rawInput,
                rawInputLength: rawInput.length,
                cleanedQuery,
                finalQuery: '',
                rewritePrompt: null,
                rewriteOutput: null,
                fallbackReason: null,
                skippedReason: 'empty-cleaned-query',
                error: null
            }
        }

        if (!this.config.enableRecallQueryRewrite) {
            return this.fallbackResult(
                rawInput,
                cleanedQuery,
                null,
                null,
                'rewrite-disabled'
            )
        }

        if (!isModelConfigured(this.config.recallRewriteModel)) {
            return this.fallbackResult(
                rawInput,
                cleanedQuery,
                null,
                null,
                'model-not-configured'
            )
        }

        let model: Awaited<ReturnType<Context['chatluna']['createChatModel']>>
        try {
            model = await this.ctx.chatluna.createChatModel(
                this.config.recallRewriteModel
            )
        } catch (error) {
            return this.fallbackResult(
                rawInput,
                cleanedQuery,
                null,
                null,
                'model-unavailable',
                summarizeError(error)
            )
        }

        if (model.value == null) {
            return this.fallbackResult(
                rawInput,
                cleanedQuery,
                null,
                null,
                'model-unavailable'
            )
        }

        const rewritePrompt = this.buildRewritePrompt(
            scope,
            cleanedQuery,
            historyMessages
        )

        try {
            const result = await model.value.invoke(rewritePrompt)
            const rewriteOutput = stringifyModelContent(result.content).trim()
            const rewrittenQuery = normalizeRewriteOutput(rewriteOutput)

            if (isSkipQuery(rewrittenQuery)) {
                return this.fallbackResult(
                    rawInput,
                    cleanedQuery,
                    rewritePrompt,
                    rewriteOutput,
                    'model-skip'
                )
            }

            if (rewrittenQuery.length === 0) {
                return this.fallbackResult(
                    rawInput,
                    cleanedQuery,
                    rewritePrompt,
                    rewriteOutput,
                    'empty-output'
                )
            }

            if (!semanticTextPattern.test(rewrittenQuery)) {
                return this.fallbackResult(
                    rawInput,
                    cleanedQuery,
                    rewritePrompt,
                    rewriteOutput,
                    'invalid-output'
                )
            }

            return {
                rawInput,
                rawInputLength: rawInput.length,
                cleanedQuery,
                finalQuery: rewrittenQuery,
                rewritePrompt,
                rewriteOutput,
                fallbackReason: null,
                skippedReason: null,
                error: null
            }
        } catch (error) {
            return this.fallbackResult(
                rawInput,
                cleanedQuery,
                rewritePrompt,
                null,
                'invoke-failed',
                summarizeError(error)
            )
        }
    }

    private fallbackResult(
        rawInput: string,
        cleanedQuery: string,
        rewritePrompt: string | null,
        rewriteOutput: string | null,
        fallbackReason: RecallQueryFallbackReason,
        error: string | null = null
    ): RecallQueryResult {
        return {
            rawInput,
            rawInputLength: rawInput.length,
            cleanedQuery,
            finalQuery: cleanedQuery,
            rewritePrompt,
            rewriteOutput,
            fallbackReason,
            skippedReason: null,
            error
        }
    }

    private buildRewritePrompt(
        scope: MemoryScope,
        cleanedQuery: string,
        historyMessages: BaseMessage[]
    ) {
        const recentMessages = this.formatter.takeRecentRounds(
            historyMessages,
            this.config.recallRewriteRounds
        )
        const history = recentMessages.length
            ? this.formatter.toExtractionPayload(scope, recentMessages).input
            : '无'

        return [
            '你是一个陪伴型长期记忆召回查询优化器。',
            '你的任务是结合最近对话和当前用户消息，写出一段用于检索长期记忆的自然语言查询文本。',
            '使用第一人称视角，其中“我”指当前 presetId 对应的角色。',
            '使用用户在对话中的称呼或名字指代用户，不要泛称“用户”。',
            '保留对关系、情绪、互动状态、重要事实的具体叙述。',
            '不要写成主题标签、分类词或关键词列表。',
            '不要输出“偏好、关系、互动状态”这类抽象概括。',
            '去掉寒暄、口癖、用户名前缀和无关噪声。',
            '不要回答用户，不要解释。',
            '只输出一行查询。',
            '',
            '正确示例：',
            'Procyon说我的研究所是虚构的。Procyon说他肚子疼。Procyon让我正确使用工具',
            '',
            '错误示例：',
            'Procyon的偏好、与某人的关系及近期互动状态',
            '',
            `conversationId=${scope.conversationId}`,
            `presetId=${scope.presetId}`,
            '',
            '最近对话：',
            '"""',
            history,
            '"""',
            '',
            '当前用户消息：',
            '"""',
            cleanedQuery,
            '"""',
            '',
            '输出：'
        ].join('\n')
    }
}
