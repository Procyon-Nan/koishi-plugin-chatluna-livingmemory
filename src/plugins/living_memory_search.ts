import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context, Logger } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { z } from 'zod'
import type { Config } from '../index'
import {
    broadSearchTextRule,
    formatSearchTextLengthRange,
    livingMemorySearchInputSchema,
    livingMemorySearchToolInputSchema,
    livingMemorySearchToolName,
    memorySearchMaxTextCount,
    specificSearchTextRule
} from '../service/memory/search_contract'

const toolDescription = [
    'Search active memories in the current preset by lexical phrase matching.',
    '',
    'Use this tool when you need to look up existing memories by both broad and specific search phrases.',
    `- broadSearchTexts: 1 to ${memorySearchMaxTextCount} short, broad phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(broadSearchTextRule)} characters after trimming. ` +
        'Use broad topics, categories, or general needs.',
    `- specificSearchTexts: optional but recommended, 1 to ${memorySearchMaxTextCount} longer, specific phrases. ` +
        `Each phrase must be ${formatSearchTextLengthRange(specificSearchTextRule)} characters after trimming when provided.`,
    '  Use concrete constraints, entities, preferences, or short factual phrases.',
    '- memoryTypes: memory categories to search, or ["all"] to search every category.',
    '- The tool only searches active memories owned by the current preset.',
    '- Specific phrase matches receive higher score than broad phrase matches. Memories matching multiple phrases receive additional score.',
    '- Each result includes matchedBroadSearchTexts and matchedSpecificSearchTexts so you can see which query phrases matched that memory.',
    '- The result is a JSON array of memory records sorted by lexical relevance, importance, then recent update time.'
].join('\n')

type ChatLunaStructuredTool = ReturnType<ChatLunaTool['createTool']>

type LivingMemorySearchToolInput = z.infer<
    typeof livingMemorySearchToolInputSchema
>

type SearchToolConfigurable = {
    preset?: unknown
    conversationId?: unknown
    userId?: unknown
    source?: unknown
    agentContext?: {
        requestId?: unknown
    }
}

interface SearchToolValidationError {
    path: string
    message: string
}

const invalidArgumentRetryLimit = 3
const invalidArgumentRetryCounts = new WeakMap<object, number>()
const invalidArgumentRetryMessage =
    'living_memory_search input is invalid. Correct the arguments and call this tool again.'
const toolCallFailedMessage =
    'living_memory_search failed because invalid arguments were provided 3 times. ' +
    'Do not call this tool again for this request. Continue replying with the ' +
    'context that the memory search tool call failed.'

const toChatLunaStructuredTool = (
    tool: LivingMemorySearchTool
): ChatLunaStructuredTool => {
    // ChatLuna and this package can resolve different @langchain/core copies in
    // local workspaces, so keep the cast at the registration boundary.
    return tool as unknown as ChatLunaStructuredTool
}

const toolMeta = {
    source: 'extension',
    group: 'living-memory',
    tags: ['living-memory', 'search'],
    defaultAvailability: {
        enabled: true,
        main: true,
        chatluna: true,
        characterScope: 'all' as const
    }
}

export function apply(ctx: Context, config: Config) {
    ctx.on('ready', () => {
        const dispose = ctx.chatluna.platform.registerTool(
            livingMemorySearchToolName,
            {
                description: toolDescription,
                selector(_history: unknown[]) {
                    return true
                },
                meta: toolMeta,
                createTool() {
                    return toChatLunaStructuredTool(
                        new LivingMemorySearchTool(ctx, config)
                    )
                }
            }
        )

        ctx.effect(() => dispose)
    })
}

class LivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = toolDescription

    schema = livingMemorySearchToolInputSchema
    private readonly logger: Logger

    constructor(
        private readonly ctx: Context,
        private readonly config: Config
    ) {
        super()
        this.logger = ctx.logger('chatluna-livingmemory')
    }

    private debug(message: string) {
        if (this.config.debug) {
            this.logger.info(message)
        }
    }

    private logContext(configurable: SearchToolConfigurable | undefined) {
        return [
            `presetId=${configurable?.preset ?? ''}`,
            `conversationId=${configurable?.conversationId ?? ''}`,
            `userId=${configurable?.userId ?? ''}`,
            `source=${configurable?.source ?? ''}`,
            `requestId=${configurable?.agentContext?.requestId ?? ''}`
        ]
    }

    private getRetryScope(configurable: SearchToolConfigurable | undefined) {
        const agentContext = configurable?.agentContext

        if (agentContext != null) {
            return agentContext
        }

        return this
    }

    private formatValidationErrors(
        error: z.ZodError
    ): SearchToolValidationError[] {
        return error.issues.map((issue) => ({
            path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
            message: issue.message
        }))
    }

    private createArgumentFailureOutput(
        configurable: SearchToolConfigurable | undefined,
        errors: SearchToolValidationError[],
        retryCount: number,
        failed: boolean
    ) {
        const output = JSON.stringify(
            {
                status: failed ? 'tool_call_failed' : 'invalid_arguments',
                message: failed
                    ? toolCallFailedMessage
                    : invalidArgumentRetryMessage,
                retryCount,
                remainingRetries: Math.max(
                    invalidArgumentRetryLimit - retryCount,
                    0
                ),
                errors
            },
            null,
            2
        )

        this.debug(
            [
                'living_memory_search output:',
                ...this.logContext(configurable),
                failed ? 'status=tool_call_failed' : 'status=invalid_arguments',
                output
            ].join('\n')
        )

        return output
    }

    private createInvalidArgumentOutput(
        configurable: SearchToolConfigurable | undefined,
        errors: SearchToolValidationError[]
    ) {
        const retryScope = this.getRetryScope(configurable)
        const retryCount = Math.min(
            (invalidArgumentRetryCounts.get(retryScope) ?? 0) + 1,
            invalidArgumentRetryLimit
        )
        invalidArgumentRetryCounts.set(retryScope, retryCount)

        return this.createArgumentFailureOutput(
            configurable,
            errors,
            retryCount,
            retryCount >= invalidArgumentRetryLimit
        )
    }

    private createRetryLimitOutput(
        configurable: SearchToolConfigurable | undefined
    ) {
        return this.createArgumentFailureOutput(
            configurable,
            [
                {
                    path: '(root)',
                    message:
                        'The invalid argument retry limit for this request has already been reached.'
                }
            ],
            invalidArgumentRetryLimit,
            true
        )
    }

    async _call(
        input: LivingMemorySearchToolInput,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const configurable = runConfig?.configurable as
            | SearchToolConfigurable
            | undefined
        const presetId = configurable?.preset

        this.debug(
            [
                'living_memory_search input:',
                ...this.logContext(configurable),
                JSON.stringify(input, null, 2)
            ].join('\n')
        )

        if (typeof presetId !== 'string' || presetId.length === 0) {
            throw new Error('Missing preset in the current tool call.')
        }

        const retryScope = this.getRetryScope(configurable)
        const retryCount = invalidArgumentRetryCounts.get(retryScope) ?? 0
        if (retryCount >= invalidArgumentRetryLimit) {
            return this.createRetryLimitOutput(configurable)
        }

        const parsedInput = livingMemorySearchInputSchema.safeParse(input)
        if (!parsedInput.success) {
            return this.createInvalidArgumentOutput(
                configurable,
                this.formatValidationErrors(parsedInput.error)
            )
        }

        const results = await this.ctx.chatluna_living_memory.searchMemories(
            presetId,
            {
                broadSearchTexts: parsedInput.data.broadSearchTexts,
                specificSearchTexts: parsedInput.data.specificSearchTexts,
                memoryTypes: parsedInput.data.memoryTypes,
                maxCandidates: this.config.memorySearchToolMaxResults
            }
        )
        invalidArgumentRetryCounts.delete(this.getRetryScope(configurable))

        const output = JSON.stringify(results, null, 2)

        this.debug(
            [
                'living_memory_search output:',
                ...this.logContext(configurable),
                `resultCount=${results.length}`,
                output
            ].join('\n')
        )

        return output
    }
}
