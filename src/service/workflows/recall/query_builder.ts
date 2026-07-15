import { Context } from 'koishi'
import { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    isModelConfigured,
    stringifyModelContent,
    summarizeError
} from '../../shared/utils'
import { buildRecallRewritePrompt } from '../../prompts'

const semanticTextPattern = /[\p{L}\p{N}]/u
const queryLineTerminatorPattern = /[。！？!?；;，,、：:]$/u

type LivingMemoryRecallQueryConfig = Pick<
    LivingMemoryConfig,
    | 'enableRecallQueryRewrite'
    | 'recallHistoryWindowRounds'
    | 'recallRewriteModel'
>

const normalizeQueryLines = (lines: string[]) => {
    return lines
        .map((line) => line.trim().replace(/\s+/gu, ' '))
        .filter((line) => semanticTextPattern.test(line))
        .reduce((sentence, line) => {
            if (sentence.length === 0) {
                return line
            }

            const separator = queryLineTerminatorPattern.test(sentence)
                ? ''
                : '，'
            return `${sentence}${separator}${line}`
        }, '')
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

const buildFallbackQuery = (
    currentMessage: LivingMemoryTranscriptMessage,
    cleanedQuery: string
) => {
    if (currentMessage.speakerLabel === '用户') {
        return cleanedQuery
    }

    return `${currentMessage.speakerLabel}说：${cleanedQuery}`.trim()
}

const toPresetLabel = (scope: MemoryScope) => {
    return scope.presetLabel?.trim() || scope.presetId
}

export type RecallQueryFallbackReason =
    | 'rewrite-disabled'
    | 'model-not-configured'
    | 'model-unavailable'
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
        private readonly config: LivingMemoryRecallQueryConfig
    ) {}

    async resolve(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ): Promise<RecallQueryResult> {
        const rawInput = currentMessage.contentLines.join('\n')
        const cleanedQuery = normalizeQueryLines(currentMessage.contentLines)
        const fallbackQuery = buildFallbackQuery(currentMessage, cleanedQuery)
        const currentTranscript = this.formatter.toExtractionPayload([
            currentMessage
        ]).input

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
                fallbackQuery,
                null,
                null,
                'rewrite-disabled'
            )
        }

        if (!isModelConfigured(this.config.recallRewriteModel)) {
            return this.fallbackResult(
                rawInput,
                cleanedQuery,
                fallbackQuery,
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
                fallbackQuery,
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
                fallbackQuery,
                null,
                null,
                'model-unavailable'
            )
        }

        const rewritePrompt = this.buildRewritePrompt(
            scope,
            cleanedQuery,
            currentTranscript,
            historyMessages
        )

        try {
            const result = await model.value.invoke(rewritePrompt)
            const rewriteOutput = stringifyModelContent(result.content).trim()
            const rewrittenQuery = normalizeRewriteOutput(rewriteOutput)

            if (rewrittenQuery.length === 0) {
                return this.fallbackResult(
                    rawInput,
                    cleanedQuery,
                    fallbackQuery,
                    rewritePrompt,
                    rewriteOutput,
                    'empty-output'
                )
            }

            if (!semanticTextPattern.test(rewrittenQuery)) {
                return this.fallbackResult(
                    rawInput,
                    cleanedQuery,
                    fallbackQuery,
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
                fallbackQuery,
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
        finalQuery: string,
        rewritePrompt: string | null,
        rewriteOutput: string | null,
        fallbackReason: RecallQueryFallbackReason,
        error: string | null = null
    ): RecallQueryResult {
        return {
            rawInput,
            rawInputLength: rawInput.length,
            cleanedQuery,
            finalQuery,
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
        currentTranscript: string,
        historyMessages: LivingMemoryTranscriptMessage[]
    ) {
        const presetLabel = toPresetLabel(scope)
        const recentMessages = this.formatter.takeRecentRounds(
            historyMessages,
            this.config.recallHistoryWindowRounds
        )
        const history = recentMessages.length
            ? this.formatter.toExtractionPayload(recentMessages).input
            : '无'

        return buildRecallRewritePrompt({
            presetLabel,
            currentTranscript,
            cleanedQuery,
            history
        })
    }
}
