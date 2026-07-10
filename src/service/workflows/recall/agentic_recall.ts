import {
    type BaseMessage,
    HumanMessage,
    ToolMessage
} from '@langchain/core/messages'
import type { Context } from 'koishi'
import type {
    AgenticMemorySearchToolCallSummary,
    AgenticMemorySnapshotItem,
    AgenticMemorySnapshotMemoryItem,
    LivingMemoryConfig,
    LivingMemorySearchInput,
    LivingMemorySearchMemoryType,
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../types'
import { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import {
    agenticRecallNoMemoryOutput,
    buildAgenticRecallPrompt
} from '../../prompts'
import { isModelConfigured, stringifyModelContent } from '../../shared/utils'
import type { DebugLogger } from '../../memory/helpers'
import {
    livingMemorySearchInputSchema,
    livingMemorySearchToolName
} from '../../memory/tools/search_contract'
import { LivingMemorySearchTool } from '../../memory/tools/search_tool'

type LivingMemoryAgenticRecallConfig = Pick<
    LivingMemoryConfig,
    | 'agenticRecallModel'
    | 'debug'
    | 'memorySearchToolMaxResults'
    | 'recallHistoryWindowRounds'
>

const agenticRecallMaxModelCalls = 6

interface AgenticRecallToolCall {
    name: string
    args: Record<string, unknown>
    id: string
}

export interface LivingMemoryAgenticRecallTrace {
    prompt: string
    finalOutput: string
    item: AgenticMemorySnapshotItem
}

const toPresetLabel = (scope: MemoryScope) => {
    return scope.presetLabel?.trim() || scope.presetId
}

const uniqueTexts = (groups: (readonly string[] | undefined)[]) => {
    return [
        ...new Set(
            groups
                .flatMap((group) => group ?? [])
                .map((text) => text.trim())
                .filter((text) => text.length > 0)
        )
    ]
}

const uniqueMemoryTypes = (
    groups: readonly LivingMemorySearchMemoryType[][]
): LivingMemorySearchMemoryType[] => {
    const values = [...new Set(groups.flat())]

    if (values.includes('all')) {
        return ['all']
    }

    return values
}

const normalizeToolCallSummary = (
    input: LivingMemorySearchInput,
    maxCandidates: number
): AgenticMemorySearchToolCallSummary => ({
    broadSearchTexts: input.broadSearchTexts,
    ...(input.specificSearchTexts == null
        ? {}
        : { specificSearchTexts: input.specificSearchTexts }),
    memoryTypes: input.memoryTypes,
    maxCandidates
})

const aggregateToolCallSummary = (
    summaries: AgenticMemorySearchToolCallSummary[],
    maxCandidates: number
): AgenticMemorySearchToolCallSummary => {
    const specificSearchTexts = uniqueTexts(
        summaries.map((summary) => summary.specificSearchTexts)
    )

    return {
        broadSearchTexts: uniqueTexts(
            summaries.map((summary) => summary.broadSearchTexts)
        ),
        ...(specificSearchTexts.length > 0 ? { specificSearchTexts } : {}),
        memoryTypes: uniqueMemoryTypes(
            summaries.map((summary) => summary.memoryTypes)
        ),
        maxCandidates
    }
}

const copyMatchedMemory = (
    item: AgenticMemorySnapshotMemoryItem
): AgenticMemorySnapshotMemoryItem => ({
    type: item.type,
    content: item.content,
    keywords: [...item.keywords],
    summary: item.summary,
    importance: item.importance,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
    matchedBroadSearchTexts: [...item.matchedBroadSearchTexts],
    matchedSpecificSearchTexts: [...item.matchedSpecificSearchTexts]
})

const uniqueMatchedMemories = (
    items: AgenticMemorySnapshotMemoryItem[]
): AgenticMemorySnapshotMemoryItem[] => {
    const seen = new Set<string>()
    const result: AgenticMemorySnapshotMemoryItem[] = []

    for (const item of items) {
        const key = [
            item.type,
            item.content,
            new Date(item.createdAt).toISOString()
        ].join('\n')

        if (seen.has(key)) {
            continue
        }

        seen.add(key)
        result.push(copyMatchedMemory(item))
    }

    return result
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value != null && !Array.isArray(value)
}

const parseToolArguments = (value: unknown): Record<string, unknown> => {
    if (value == null) {
        return {}
    }

    if (isRecord(value)) {
        return value
    }

    if (typeof value === 'string') {
        if (value.trim().length === 0) {
            return {}
        }

        try {
            const parsed = JSON.parse(value)
            if (isRecord(parsed)) {
                return parsed
            }
        } catch {
            return {}
        }
    }

    return {}
}

const extractToolCalls = (
    message: BaseMessage,
    modelCallIndex: number
): AgenticRecallToolCall[] => {
    const directToolCalls = (message as { tool_calls?: unknown }).tool_calls
    if (Array.isArray(directToolCalls) && directToolCalls.length > 0) {
        return directToolCalls.map((toolCall, index) => {
            if (!isRecord(toolCall) || typeof toolCall.name !== 'string') {
                throw new Error('Model returned an invalid tool call.')
            }

            return {
                name: toolCall.name,
                args: parseToolArguments(toolCall.args),
                id:
                    typeof toolCall.id === 'string'
                        ? toolCall.id
                        : `agentic_recall_${modelCallIndex}_${index}`
            }
        })
    }

    const rawToolCalls = message.additional_kwargs?.tool_calls
    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        return rawToolCalls.map((toolCall, index) => {
            if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
                throw new Error('Model returned an invalid raw tool call.')
            }

            const name = toolCall.function.name
            if (typeof name !== 'string') {
                throw new Error('Model returned a raw tool call without name.')
            }

            return {
                name,
                args: parseToolArguments(toolCall.function.arguments),
                id:
                    typeof toolCall.id === 'string'
                        ? toolCall.id
                        : `agentic_recall_${modelCallIndex}_${index}`
            }
        })
    }

    return []
}

const parseMatchedMemories = (
    output: string
): AgenticMemorySnapshotMemoryItem[] => {
    const parsed = JSON.parse(output)
    if (!Array.isArray(parsed)) {
        return []
    }

    return parsed.map((item) =>
        copyMatchedMemory(item as AgenticMemorySnapshotMemoryItem)
    )
}

const toToolOutputText = (output: unknown) => {
    if (typeof output === 'string') {
        return output
    }

    return JSON.stringify(output)
}

const createUnavailableToolMessage = (
    toolCall: AgenticRecallToolCall
): ToolMessage => {
    return new ToolMessage({
        content:
            `Tool '${toolCall.name}' is not available. ` +
            `Use ${livingMemorySearchToolName} or finish with ${agenticRecallNoMemoryOutput}.`,
        tool_call_id: toolCall.id,
        name: toolCall.name,
        status: 'error'
    })
}

export class LivingMemoryAgenticRecallExecutor {
    private readonly formatter = new LivingMemoryMessageFormatter()

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryAgenticRecallConfig,
        private readonly debug: DebugLogger
    ) {}

    async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ): Promise<LivingMemoryAgenticRecallTrace> {
        if (!isModelConfigured(this.config.agenticRecallModel)) {
            throw new Error('agenticRecallModel is not configured.')
        }

        const model = await this.ctx.chatluna.createChatModel(
            this.config.agenticRecallModel
        )
        if (model.value == null) {
            throw new Error('agenticRecallModel is unavailable.')
        }

        const presetLabel = toPresetLabel(scope)
        const currentTranscript = this.formatter.toExtractionPayload([
            currentMessage
        ]).input
        const recentMessages = this.formatter.takeRecentRounds(
            historyMessages,
            this.config.recallHistoryWindowRounds
        )
        const history = recentMessages.length
            ? this.formatter.toExtractionPayload(recentMessages).input
            : '无'
        const prompt = buildAgenticRecallPrompt({
            presetLabel,
            currentTranscript,
            history
        })
        const searchTool = new LivingMemorySearchTool(this.ctx, this.config)
        const agentContext = {
            requestId: [
                'agentic-recall',
                scope.presetId,
                scope.conversationId,
                Date.now()
            ].join(':')
        }
        const toolConfig = {
            configurable: {
                preset: scope.presetId,
                conversationId: scope.conversationId,
                userId: scope.userId,
                source: 'agentic-recall',
                agentContext
            }
        }
        const modelOptions = {
            tools: [searchTool]
        } as unknown as Parameters<typeof model.value.invoke>[1]
        const messages: BaseMessage[] = [new HumanMessage(prompt)]
        const toolCallSummaries: AgenticMemorySearchToolCallSummary[] = []
        const matchedMemories: AgenticMemorySnapshotMemoryItem[] = []
        let toolCallCount = 0

        this.debug(
            [
                `memory agentic recall prompt: conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                prompt
            ].join('\n')
        )

        for (
            let modelCallIndex = 0;
            modelCallIndex < agenticRecallMaxModelCalls;
            modelCallIndex += 1
        ) {
            const response = await model.value.invoke(messages, modelOptions)
            messages.push(response)

            const output = stringifyModelContent(response.content).trim()
            const toolCalls = extractToolCalls(response, modelCallIndex)

            this.debug(
                [
                    `memory agentic recall turn: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `modelCall=${modelCallIndex + 1}`,
                    `toolCalls=${toolCalls.length}`,
                    'output:',
                    output
                ].join('\n')
            )

            if (toolCalls.length === 0) {
                return this.createTrace(
                    prompt,
                    output,
                    toolCallCount,
                    matchedMemories,
                    toolCallSummaries
                )
            }

            for (const toolCall of toolCalls) {
                if (toolCall.name !== livingMemorySearchToolName) {
                    messages.push(createUnavailableToolMessage(toolCall))
                    continue
                }

                toolCallCount += 1
                const parsedInput = livingMemorySearchInputSchema.safeParse(
                    toolCall.args
                )
                if (parsedInput.success) {
                    const toolInput: LivingMemorySearchInput = {
                        broadSearchTexts: parsedInput.data.broadSearchTexts,
                        specificSearchTexts:
                            parsedInput.data.specificSearchTexts,
                        memoryTypes: parsedInput.data.memoryTypes
                    }

                    toolCallSummaries.push(
                        normalizeToolCallSummary(
                            toolInput,
                            this.config.memorySearchToolMaxResults
                        )
                    )
                }

                const toolOutput = toToolOutputText(
                    await searchTool.invoke(toolCall.args, toolConfig)
                )
                matchedMemories.push(...parseMatchedMemories(toolOutput))
                messages.push(
                    new ToolMessage({
                        content: toolOutput,
                        tool_call_id: toolCall.id,
                        name: livingMemorySearchToolName
                    })
                )
            }
        }

        throw new Error('agentic recall reached max model calls.')
    }

    private createTrace(
        prompt: string,
        finalOutput: string,
        toolCallCount: number,
        matchedMemories: AgenticMemorySnapshotMemoryItem[],
        toolCallSummaries: AgenticMemorySearchToolCallSummary[]
    ): LivingMemoryAgenticRecallTrace {
        if (toolCallCount === 0) {
            throw new Error(
                'agentic recall finished without calling living_memory_search.'
            )
        }

        if (finalOutput.length === 0) {
            throw new Error('agentic recall final output is empty.')
        }

        const uniqueMemories = uniqueMatchedMemories(matchedMemories)
        const finalText =
            finalOutput === agenticRecallNoMemoryOutput ? '' : finalOutput

        if (finalText.length > 0 && uniqueMemories.length === 0) {
            throw new Error(
                'agentic recall produced memory text without matched memories.'
            )
        }

        return {
            prompt,
            finalOutput,
            item: {
                finalText,
                toolCallSummary: aggregateToolCallSummary(
                    toolCallSummaries,
                    this.config.memorySearchToolMaxResults
                ),
                matchedBroadSearchTexts: uniqueTexts(
                    uniqueMemories.map((item) => item.matchedBroadSearchTexts)
                ),
                matchedSpecificSearchTexts: uniqueTexts(
                    uniqueMemories.map(
                        (item) => item.matchedSpecificSearchTexts
                    )
                ),
                matchedMemories: uniqueMemories
            }
        }
    }
}
