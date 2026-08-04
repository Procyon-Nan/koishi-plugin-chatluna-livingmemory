import {
    type BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import {
    ChatPromptTemplate,
    MessagesPlaceholder
} from '@langchain/core/prompts'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'
import type { ChainValues } from '@langchain/core/utils/types'
import type { z } from 'zod'
import type { Context } from 'koishi'
import {
    _formatIntermediateSteps,
    AgentRunner,
    createOpenAIAgent
} from 'koishi-plugin-chatluna/llm-core/agent'
import type {
    AgentAction,
    AgentFinish,
    AgentStep,
    ScratchpadEntry
} from 'koishi-plugin-chatluna/llm-core/agent'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    AgenticMemorySearchToolCallSummary,
    AgenticMemorySnapshotItem,
    AgenticMemorySnapshotMemoryItem,
    LivingMemorySearchInput,
    LivingMemorySearchMemoryType,
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import {
    agenticRecallNoMemoryOutput,
    buildAgenticRecallFinalizationPrompt,
    buildAgenticRecallPrompt
} from '../../prompts'
import type { AgenticRecallPromptMessages } from '../../prompts'
import { formatPromptMessagesTrace } from '../../prompts/prompt_format'
import { isModelConfigured, stringifyModelContent } from '../../shared/utils'
import type { DebugLogger } from '../../memory/helpers'
import {
    livingMemorySearchInputSchema,
    livingMemorySearchToolName
} from '../../memory/tools/search_contract'
import {
    LivingMemorySearchTool,
    livingMemorySearchToolDescription
} from '../../memory/tools/embedding_search_tool'
import {
    createEmbeddingSearchCache,
    type LivingMemoryEmbeddingSearchEngine
} from './embedding_search_engine'

type LivingMemoryAgenticRecallConfig = Pick<
    LivingMemoryConfig,
    | 'subModel'
    | 'debug'
    | 'memorySearchToolMaxResults'
    | 'recallHistoryWindowRounds'
    | 'embeddingModel'
>

type AgenticSearchToolInput = z.infer<typeof livingMemorySearchInputSchema>

interface RecordedAgenticSearchCall {
    inputKey: string
    input: Record<string, unknown>
    output: string
}

type AgenticRecallDecision = AgentAction | AgentAction[] | AgentFinish

type AgenticRecallToolAgentInput = ChainValues & {
    steps: AgentStep[]
    scratchpadEntries?: ScratchpadEntry[]
}

const agenticRecallMaxModelCalls = 6

const agenticRecallPromptTemplate = ChatPromptTemplate.fromMessages([
    ['system', '{systemPrompt}'],
    ['human', '{inputPrompt}'],
    new MessagesPlaceholder('agent_scratchpad')
])

export interface LivingMemoryAgenticRecallTrace {
    prompt: string
    finalOutput: string
    item: AgenticMemorySnapshotItem
}

const toAssistantLabel = (scope: MemoryScope) => {
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
    searchTexts: input.searchTexts,
    searchKeywords: input.searchKeywords ?? [],
    memoryTypes: input.memoryTypes,
    maxCandidates
})

const aggregateToolCallSummary = (
    summaries: AgenticMemorySearchToolCallSummary[],
    maxCandidates: number
): AgenticMemorySearchToolCallSummary => {
    return {
        searchTexts: uniqueTexts(
            summaries.map((summary) => summary.searchTexts)
        ),
        searchKeywords: uniqueTexts(
            summaries.map((summary) => summary.searchKeywords)
        ),
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
    updatedAt: new Date(item.updatedAt)
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

const createSearchInputKey = (input: unknown) => {
    const parsedInput = livingMemorySearchInputSchema.safeParse(input)
    return JSON.stringify(parsedInput.success ? parsedInput.data : input)
}

const hasToolCalls = (message: BaseMessage) => {
    const directToolCalls = (message as { tool_calls?: unknown }).tool_calls
    if (Array.isArray(directToolCalls) && directToolCalls.length > 0) {
        return true
    }

    const rawToolCalls = message.additional_kwargs?.tool_calls
    return Array.isArray(rawToolCalls) && rawToolCalls.length > 0
}

const orderRecordedSearchCalls = (
    calls: RecordedAgenticSearchCall[],
    steps: AgentStep[] | undefined
) => {
    const callsByInput = new Map<string, RecordedAgenticSearchCall[]>()
    for (const call of calls) {
        const group = callsByInput.get(call.inputKey) ?? []
        group.push(call)
        callsByInput.set(call.inputKey, group)
    }

    const ordered: RecordedAgenticSearchCall[] = []
    for (const step of steps ?? []) {
        if (step.action.tool !== livingMemorySearchToolName) {
            continue
        }

        const group = callsByInput.get(
            createSearchInputKey(step.action.toolInput)
        )
        const call = group?.shift()
        if (call != null) {
            ordered.push(call)
        }
    }

    return ordered
}

const formatDecisionOutput = (decision: AgenticRecallDecision) => {
    if (Array.isArray(decision)) {
        return decision
            .map((action) => action.log.trim())
            .filter((value) => value.length > 0)
            .join('\n')
    }

    if ('returnValues' in decision) {
        return toToolOutputText(decision.returnValues['output']).trim()
    }

    return decision.log.trim()
}

class RecordingLivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = livingMemorySearchToolDescription
    schema = livingMemorySearchInputSchema

    constructor(
        private readonly delegate: LivingMemorySearchTool,
        private readonly calls: RecordedAgenticSearchCall[],
        private readonly agentContext: { requestId: string }
    ) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: AgenticSearchToolInput,
        runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        // AgentRunner 会复制 RunnableConfig，显式复用本次 run 的 agentContext，
        // 以保持工具参数重试计数的请求级作用域。
        const delegateConfig = {
            ...(runConfig ?? {}),
            configurable: {
                ...(runConfig?.configurable ?? {}),
                agentContext: this.agentContext
            }
        } as ToolRunnableConfig
        const output = toToolOutputText(
            await this.delegate._call(input, runManager, delegateConfig)
        )
        this.calls.push({
            inputKey: createSearchInputKey(input),
            input: { ...input },
            output
        })
        return output
    }
}

export class LivingMemoryAgenticRecallExecutor {
    private readonly formatter = new LivingMemoryMessageFormatter()

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryAgenticRecallConfig,
        private readonly embeddingSearchEngine: LivingMemoryEmbeddingSearchEngine,
        private readonly debug: DebugLogger
    ) {}

    async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ): Promise<LivingMemoryAgenticRecallTrace> {
        if (!isModelConfigured(this.config.subModel)) {
            throw new Error('subModel is not configured.')
        }

        const model = await this.ctx.chatluna.createChatModel(
            this.config.subModel
        )
        const chatModel = model.value
        if (chatModel == null) {
            throw new Error('subModel is unavailable.')
        }

        const assistantLabel = toAssistantLabel(scope)
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
            assistantLabel,
            currentTranscript,
            history
        })
        const promptTrace = formatPromptMessagesTrace(prompt)
        const agentContext = {
            requestId: [
                'agentic-recall',
                scope.presetId,
                scope.conversationId,
                Date.now()
            ].join(':')
        }
        const recordedSearchCalls: RecordedAgenticSearchCall[] = []
        const searchCache = createEmbeddingSearchCache()
        const searchTool = new RecordingLivingMemorySearchTool(
            new LivingMemorySearchTool(
                this.embeddingSearchEngine,
                searchCache,
                this.ctx,
                this.config
            ),
            recordedSearchCalls,
            agentContext
        )
        const toolAgent = createOpenAIAgent({
            llm: chatModel,
            tools: [searchTool],
            prompt: agenticRecallPromptTemplate
        })
        let modelCallCount = 0
        let usedFinalizationCall = false

        const boundedAgent = RunnableLambda.from(
            async (
                input: ChainValues,
                runConfig?: RunnableConfig
            ): Promise<AgenticRecallDecision> => {
                modelCallCount += 1

                let decision: AgenticRecallDecision
                if (modelCallCount === agenticRecallMaxModelCalls) {
                    usedFinalizationCall = true
                    decision = await this.finalize(
                        chatModel,
                        prompt,
                        input,
                        runConfig
                    )
                } else {
                    decision = await toolAgent.invoke(
                        input as AgenticRecallToolAgentInput,
                        runConfig
                    )
                }

                this.debug(
                    [
                        `memory agentic recall turn: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `modelCall=${modelCallCount}`,
                        `toolCalls=${
                            Array.isArray(decision)
                                ? decision.length
                                : 'returnValues' in decision
                                  ? 0
                                  : 1
                        }`,
                        'output:',
                        formatDecisionOutput(decision)
                    ].join('\n')
                )

                return decision
            }
        )
        const runner = AgentRunner.fromAgentAndTools({
            agent: boundedAgent,
            tools: [searchTool],
            maxIterations: agenticRecallMaxModelCalls,
            returnIntermediateSteps: true,
            handleParsingErrors: (error) => {
                return [
                    `Invalid tool call: ${error.message}`,
                    `Correct the tool name or arguments, then retry the tool call or finish with ${agenticRecallNoMemoryOutput}.`
                ].join(' ')
            },
            handleToolRuntimeErrors: (error) => {
                throw error
            }
        })

        this.debug(
            [
                `memory agentic recall prompt: conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                promptTrace
            ].join('\n')
        )

        const result = await runner.invoke(
            {
                systemPrompt: prompt.systemPrompt,
                inputPrompt: prompt.inputPrompt
            },
            {
                configurable: {
                    model: chatModel,
                    preset: scope.presetId,
                    conversationId: scope.conversationId,
                    userId: scope.userId,
                    source: 'agentic-recall',
                    agentContext
                }
            }
        )
        const toolCallSummaries: AgenticMemorySearchToolCallSummary[] = []
        const matchedMemories: AgenticMemorySnapshotMemoryItem[] = []
        const orderedSearchCalls = orderRecordedSearchCalls(
            recordedSearchCalls,
            result.intermediateSteps
        )

        for (const call of orderedSearchCalls) {
            const parsedInput = livingMemorySearchInputSchema.safeParse(
                call.input
            )
            if (parsedInput.success) {
                toolCallSummaries.push(
                    normalizeToolCallSummary(
                        {
                            searchTexts: parsedInput.data.searchTexts,
                            searchKeywords:
                                parsedInput.data.searchKeywords ?? [],
                            memoryTypes: parsedInput.data.memoryTypes
                        },
                        this.config.memorySearchToolMaxResults
                    )
                )
            }

            matchedMemories.push(...parseMatchedMemories(call.output))
        }

        const trace = this.createTrace(
            promptTrace,
            result.output.trim(),
            matchedMemories,
            toolCallSummaries
        )

        if (
            usedFinalizationCall &&
            trace.finalOutput === agenticRecallNoMemoryOutput
        ) {
            this.debug(
                [
                    `memory agentic recall exhausted: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `modelCalls=${modelCallCount}`,
                    'reason=max-model-calls'
                ].join(' ')
            )
        }

        return trace
    }

    private async finalize(
        model: ChatLunaChatModel,
        prompt: AgenticRecallPromptMessages,
        input: ChainValues,
        runConfig?: RunnableConfig
    ): Promise<AgentFinish> {
        const scratchpad = _formatIntermediateSteps(
            (input['scratchpadEntries'] ??
                input['steps'] ??
                []) as ScratchpadEntry[]
        )
        const response = await model.invoke(
            [
                new SystemMessage(prompt.systemPrompt),
                new HumanMessage(prompt.inputPrompt),
                ...scratchpad,
                new HumanMessage(buildAgenticRecallFinalizationPrompt())
            ],
            {
                ...(runConfig ?? {}),
                tools: []
            } as Parameters<ChatLunaChatModel['invoke']>[1]
        )
        const output = stringifyModelContent(response.content).trim()
        const finalOutput =
            output.length === 0 || hasToolCalls(response)
                ? agenticRecallNoMemoryOutput
                : output

        return {
            returnValues: {
                output: finalOutput,
                message: response
            },
            log: finalOutput
        }
    }

    private createTrace(
        prompt: string,
        finalOutput: string,
        matchedMemories: AgenticMemorySnapshotMemoryItem[],
        toolCallSummaries: AgenticMemorySearchToolCallSummary[]
    ): LivingMemoryAgenticRecallTrace {
        const uniqueMemories = uniqueMatchedMemories(matchedMemories)
        const noMemories = uniqueMemories.length === 0
        const resolvedOutput =
            finalOutput.length === 0 ||
            (finalOutput !== agenticRecallNoMemoryOutput && noMemories)
                ? agenticRecallNoMemoryOutput
                : finalOutput

        const finalText =
            resolvedOutput === agenticRecallNoMemoryOutput ? '' : resolvedOutput

        return {
            prompt,
            finalOutput: resolvedOutput,
            item: {
                finalText,
                toolCallSummary: aggregateToolCallSummary(
                    toolCallSummaries,
                    this.config.memorySearchToolMaxResults
                ),
                matchedMemories: uniqueMemories
            }
        }
    }
}
