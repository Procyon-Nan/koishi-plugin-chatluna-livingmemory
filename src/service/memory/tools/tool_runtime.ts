import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Logger } from 'koishi'

export type LivingMemoryToolConfigurable = {
    preset?: unknown
    conversationId?: unknown
    userId?: unknown
    source?: unknown
    agentContext?: {
        requestId?: unknown
    }
}

export const getLivingMemoryToolConfigurable = (
    runConfig?: ToolRunnableConfig
) => {
    return runConfig?.configurable as LivingMemoryToolConfigurable | undefined
}

interface LivingMemoryToolRuntimeOptions {
    toolName: string
    logger: Pick<Logger, 'info'>
    isDebugEnabled: () => boolean
}

export class LivingMemoryToolRuntime {
    constructor(private readonly options: LivingMemoryToolRuntimeOptions) {}

    logInput(
        configurable: LivingMemoryToolConfigurable | undefined,
        input: unknown
    ) {
        this.debug(() =>
            [
                `${this.options.toolName} input:`,
                ...this.logContext(configurable),
                `inputLength=${JSON.stringify(input).length}`
            ].join(' ')
        )
    }

    logOutput(
        configurable: LivingMemoryToolConfigurable | undefined,
        output: string,
        details: string[] = []
    ) {
        this.debug(() =>
            [
                `${this.options.toolName} output:`,
                ...this.logContext(configurable),
                ...details,
                `outputLength=${output.length}`
            ].join(' ')
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

    private debug(buildMessage: () => string) {
        if (this.options.isDebugEnabled()) {
            this.options.logger.info(buildMessage())
        }
    }
}
