import { Context } from 'koishi'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import { resolveScopeAssistantLabel } from '../../memory/helpers'
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
import type { PromptMessages } from '../../prompts/prompt_format'
import { invokeLoggedModel } from '../../logging/model_calls'
import type { LivingMemoryLogger } from '../../logging/logger'

const semanticTextPattern = /[\p{L}\p{N}]/u
const queryLineTerminatorPattern = /[。！？!?；;，,、：:]$/u

type LivingMemoryRecallQueryConfig = Pick<
    LivingMemoryConfig,
    'enableRecallQueryRewrite' | 'recallHistoryWindowRounds' | 'subModel'
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
    rewritePrompt: PromptMessages | null
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
        historyMessages: LivingMemoryTranscriptMessage[],
        logger?: LivingMemoryLogger
    ): Promise<RecallQueryResult> {
        const rawInput = currentMessage.contentLines.join('\n')
        const cleanedQuery = normalizeQueryLines(currentMessage.contentLines)
        const fallbackQuery = buildFallbackQuery(currentMessage, cleanedQuery)
        const currentTranscript = this.formatter.toExtractionPayload([
            currentMessage
        ]).input
        const fallback = (
            fallbackReason: RecallQueryFallbackReason,
            rewritePrompt: PromptMessages | null = null,
            rewriteOutput: string | null = null,
            error: string | null = null
        ): RecallQueryResult =>
            this.fallbackResult(
                rawInput,
                cleanedQuery,
                fallbackQuery,
                rewritePrompt,
                rewriteOutput,
                fallbackReason,
                error
            )

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
            return fallback('rewrite-disabled')
        }

        if (!isModelConfigured(this.config.subModel)) {
            return fallback('model-not-configured')
        }

        let model: Awaited<ReturnType<Context['chatluna']['createChatModel']>>
        try {
            model = await this.ctx.chatluna.createChatModel(
                this.config.subModel
            )
        } catch (error) {
            return fallback(
                'model-unavailable',
                null,
                null,
                summarizeError(error)
            )
        }

        if (model.value == null) {
            return fallback('model-unavailable')
        }

        const rewritePromptMessages = this.buildRewritePrompt(
            scope,
            cleanedQuery,
            currentTranscript,
            historyMessages
        )
        try {
            const messages = [
                new SystemMessage(rewritePromptMessages.systemPrompt),
                new HumanMessage(rewritePromptMessages.inputPrompt)
            ]
            const result =
                logger == null
                    ? await model.value.invoke(messages)
                    : await invokeLoggedModel(
                          model.value,
                          messages,
                          undefined,
                          {
                              logger,
                              stage: 'query-rewrite',
                              attempt: 1
                          }
                      )
            const rewriteOutput = stringifyModelContent(result.content).trim()
            const rewrittenQuery = normalizeRewriteOutput(rewriteOutput)

            if (rewrittenQuery.length === 0) {
                return fallback(
                    'empty-output',
                    rewritePromptMessages,
                    rewriteOutput
                )
            }

            if (!semanticTextPattern.test(rewrittenQuery)) {
                return fallback(
                    'invalid-output',
                    rewritePromptMessages,
                    rewriteOutput
                )
            }

            return {
                rawInput,
                rawInputLength: rawInput.length,
                cleanedQuery,
                finalQuery: rewrittenQuery,
                rewritePrompt: rewritePromptMessages,
                rewriteOutput,
                fallbackReason: null,
                skippedReason: null,
                error: null
            }
        } catch (error) {
            return fallback(
                'invoke-failed',
                rewritePromptMessages,
                null,
                summarizeError(error)
            )
        }
    }

    private fallbackResult(
        rawInput: string,
        cleanedQuery: string,
        finalQuery: string,
        rewritePrompt: PromptMessages | null,
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
        lastMessage: string,
        historyMessages: LivingMemoryTranscriptMessage[]
    ) {
        const assistantLabel = resolveScopeAssistantLabel(scope)
        const recentMessages = this.formatter.takeRecentRounds(
            historyMessages,
            this.config.recallHistoryWindowRounds
        )
        const chatHistory =
            this.formatter.toExtractionPayload(recentMessages).input

        return buildRecallRewritePrompt({
            assistantLabel,
            lastMessage,
            cleanedQuery,
            chatHistory
        })
    }
}
