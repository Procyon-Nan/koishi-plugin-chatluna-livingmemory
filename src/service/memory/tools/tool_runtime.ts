import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { LivingMemoryLogger } from '../../logging/logger'

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
    logger: LivingMemoryLogger
}

export class LivingMemoryToolRuntime {
    constructor(private readonly options: LivingMemoryToolRuntimeOptions) {}

    logInput(
        configurable: LivingMemoryToolConfigurable | undefined,
        input: unknown
    ) {
        this.options.logger.diagnostic('tool.input', () => ({
            ...this.logContext(configurable),
            tool: this.options.toolName,
            inputLength: JSON.stringify(input).length
        }))
    }

    logOutput(
        configurable: LivingMemoryToolConfigurable | undefined,
        output: string,
        details: Record<string, unknown> = {}
    ) {
        this.options.logger.diagnostic('tool.output', {
            ...this.logContext(configurable),
            ...details,
            tool: this.options.toolName,
            outputLength: output.length
        })
    }

    private logContext(configurable: LivingMemoryToolConfigurable | undefined) {
        return {
            presetId: configurable?.preset,
            conversationId: configurable?.conversationId,
            userId: configurable?.userId,
            source: configurable?.source,
            requestId: configurable?.agentContext?.requestId
        }
    }
}
