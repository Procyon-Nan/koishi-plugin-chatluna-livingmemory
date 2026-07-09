import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Logger } from 'koishi'
import type { z } from 'zod'

export type LivingMemoryToolConfigurable = {
    preset?: unknown
    conversationId?: unknown
    userId?: unknown
    source?: unknown
    agentContext?: {
        requestId?: unknown
    }
}

export interface LivingMemoryToolValidationError {
    path: string
    message: string
}

export const livingMemoryToolInvalidArgumentRetryLimit = 3

const invalidArgumentRetryCountsByToolName = new Map<
    string,
    WeakMap<object, number>
>()

const getInvalidArgumentRetryCounts = (toolName: string) => {
    const existing = invalidArgumentRetryCountsByToolName.get(toolName)
    if (existing != null) {
        return existing
    }

    const counts = new WeakMap<object, number>()
    invalidArgumentRetryCountsByToolName.set(toolName, counts)
    return counts
}

export const getLivingMemoryToolConfigurable = (
    runConfig?: ToolRunnableConfig
) => {
    return runConfig?.configurable as LivingMemoryToolConfigurable | undefined
}

interface LivingMemoryToolRuntimeOptions {
    toolName: string
    logger: Logger
    isDebugEnabled: () => boolean
    invalidArgumentRetryMessage: string
    toolCallFailedMessage: string
}

export class LivingMemoryToolRuntime {
    constructor(
        private readonly options: LivingMemoryToolRuntimeOptions,
        private readonly fallbackRetryScope: object
    ) {}

    formatValidationErrors(
        error: z.ZodError
    ): LivingMemoryToolValidationError[] {
        return error.issues.map((issue) => ({
            path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
            message: issue.message
        }))
    }

    logInput(
        configurable: LivingMemoryToolConfigurable | undefined,
        input: unknown
    ) {
        this.debug(
            [
                `${this.options.toolName} input:`,
                ...this.logContext(configurable),
                JSON.stringify(input, null, 2)
            ].join('\n')
        )
    }

    logOutput(
        configurable: LivingMemoryToolConfigurable | undefined,
        output: string,
        details: string[] = []
    ) {
        this.debug(
            [
                `${this.options.toolName} output:`,
                ...this.logContext(configurable),
                ...details,
                output
            ].join('\n')
        )
    }

    hasReachedRetryLimit(
        configurable: LivingMemoryToolConfigurable | undefined
    ) {
        const retryScope = this.getRetryScope(configurable)
        const retryCount =
            getInvalidArgumentRetryCounts(this.options.toolName).get(
                retryScope
            ) ?? 0

        return retryCount >= livingMemoryToolInvalidArgumentRetryLimit
    }

    createInvalidArgumentOutput(
        configurable: LivingMemoryToolConfigurable | undefined,
        errors: LivingMemoryToolValidationError[]
    ) {
        const retryScope = this.getRetryScope(configurable)
        const retryCounts = getInvalidArgumentRetryCounts(this.options.toolName)
        const retryCount = Math.min(
            (retryCounts.get(retryScope) ?? 0) + 1,
            livingMemoryToolInvalidArgumentRetryLimit
        )
        retryCounts.set(retryScope, retryCount)

        return this.createArgumentFailureOutput(
            configurable,
            errors,
            retryCount,
            retryCount >= livingMemoryToolInvalidArgumentRetryLimit
        )
    }

    createRetryLimitOutput(
        configurable: LivingMemoryToolConfigurable | undefined
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
            livingMemoryToolInvalidArgumentRetryLimit,
            true
        )
    }

    clearInvalidArgumentRetry(
        configurable: LivingMemoryToolConfigurable | undefined
    ) {
        getInvalidArgumentRetryCounts(this.options.toolName).delete(
            this.getRetryScope(configurable)
        )
    }

    private logContext(configurable: LivingMemoryToolConfigurable | undefined) {
        return [
            `presetId=${configurable?.preset ?? ''}`,
            `conversationId=${configurable?.conversationId ?? ''}`,
            `userId=${configurable?.userId ?? ''}`,
            `source=${configurable?.source ?? ''}`,
            `requestId=${configurable?.agentContext?.requestId ?? ''}`
        ]
    }

    private getRetryScope(
        configurable: LivingMemoryToolConfigurable | undefined
    ) {
        return configurable?.agentContext ?? this.fallbackRetryScope
    }

    private createArgumentFailureOutput(
        configurable: LivingMemoryToolConfigurable | undefined,
        errors: LivingMemoryToolValidationError[],
        retryCount: number,
        failed: boolean
    ) {
        const output = JSON.stringify(
            {
                status: failed ? 'tool_call_failed' : 'invalid_arguments',
                message: failed
                    ? this.options.toolCallFailedMessage
                    : this.options.invalidArgumentRetryMessage,
                retryCount,
                remainingRetries: Math.max(
                    livingMemoryToolInvalidArgumentRetryLimit - retryCount,
                    0
                ),
                errors
            },
            null,
            2
        )

        this.logOutput(configurable, output, [
            failed ? 'status=tool_call_failed' : 'status=invalid_arguments'
        ])

        return output
    }

    private debug(message: string) {
        if (this.options.isDebugEnabled()) {
            this.options.logger.info(message)
        }
    }
}
