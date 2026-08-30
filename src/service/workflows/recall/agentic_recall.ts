import {
    ChatPromptTemplate,
    MessagesPlaceholder
} from '@langchain/core/prompts'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'
import type { ChainValues } from '@langchain/core/utils/types'
import type { Context } from 'koishi'
import {
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
import { buildAgenticRecallPrompt } from '../../prompts'
import type { AgenticRecallPromptMessages } from '../../prompts'
import { isModelConfigured } from '../../shared/utils'
import type { LivingMemoryLogger } from '../../logging/logger'
import { createLoggedModel } from '../../logging/model_calls'
import {
    livingMemorySearchInputSchema,
    livingMemorySearchToolName
} from '../../memory/tools/search_contract'
import {
    LivingMemorySearchTool,
    livingMemorySearchToolDescription
} from '../../memory/tools/embedding_search_tool'
import { resolveScopeAssistantLabel } from '../../memory/helpers'
import type { LivingMemoryEmbeddingSearchEngine } from './embedding_search_engine'

type LivingMemoryAgenticRecallConfig = Pick<
    LivingMemoryConfig,
    | 'subModel'
    | 'debug'
    | 'memorySearchToolMaxResults'
    | 'recallHistoryWindowRounds'
>

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
const agenticRecallExhaustedMessage =
    `agentic recall did not finish within ${agenticRecallMaxModelCalls} model calls`

const agenticRecallPromptTemplate = ChatPromptTemplate.fromMessages([
    ['system', '{systemPrompt}'],
    ['human', '{inputPrompt}'],
    new MessagesPlaceholder('agent_scratchpad')
])

export interface LivingMemoryAgenticRecallTrace {
    prompt: AgenticRecallPromptMessages
    item: AgenticMemorySnapshotItem
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

class RecordingLivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = livingMemorySearchToolDescription
    schema = livingMemorySearchInputSchema

    constructor(
        private readonly delegate: LivingMemorySearchTool,
        private readonly calls: RecordedAgenticSearchCall[],
        private readonly agentContext: { requestId: string },
        private readonly logger: LivingMemoryLogger
    ) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: LivingMemorySearchInput,
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
        this.logger.diagnostic('recall.agentic.search.results', {}, () => [
            {
                title: 'memories',
                key: 'memories',
                value: JSON.parse(output)
            }
        ])
        return output
    }
}

export class LivingMemoryAgenticRecallExecutor {
    private readonly formatter = new LivingMemoryMessageFormatter()

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryAgenticRecallConfig,
        private readonly embeddingSearchEngine: LivingMemoryEmbeddingSearchEngine,
        private readonly logger: LivingMemoryLogger
    ) {}

    async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[],
        runLogger: LivingMemoryLogger = this.logger
    ): Promise<LivingMemoryAgenticRecallTrace | null> {
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

        const prompt = this.buildRecallPrompt(
            scope,
            currentMessage,
            historyMessages
        )
        const agentContext = {
            requestId: [
                'agentic-recall',
                scope.presetId,
                scope.conversationId,
                Date.now()
            ].join(':')
        }
        const recordedSearchCalls: RecordedAgenticSearchCall[] = []
        const searchTool = new RecordingLivingMemorySearchTool(
            new LivingMemorySearchTool(this.embeddingSearchEngine),
            recordedSearchCalls,
            agentContext,
            runLogger
        )
        const { runner, hasExhaustedModelCalls } =
            this.createBoundedAgentRunner(chatModel, searchTool, runLogger)

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
        if (hasExhaustedModelCalls()) {
            throw new Error(agenticRecallExhaustedMessage)
        }
        const { toolCallSummaries, matchedMemories } =
            this.collectSearchResults(
                recordedSearchCalls,
                result.intermediateSteps
            )
        const finalText = result.output.trim()
        const uniqueMemories = uniqueMatchedMemories(matchedMemories)
        if (
            finalText.length === 0 ||
            finalText === '<NO_MEMORY>' ||
            uniqueMemories.length === 0
        ) {
            return null
        }

        return {
            prompt,
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

    private buildRecallPrompt(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ): AgenticRecallPromptMessages {
        const assistantLabel = resolveScopeAssistantLabel(scope)
        const lastMessage = this.formatter.toExtractionPayload([
            currentMessage
        ]).input
        const recentMessages = this.formatter.takeRecentRounds(
            historyMessages,
            this.config.recallHistoryWindowRounds
        )
        const chatHistory =
            this.formatter.toExtractionPayload(recentMessages).input
        return buildAgenticRecallPrompt({
            assistantLabel,
            lastMessage,
            chatHistory
        })
    }

    private createBoundedAgentRunner(
        chatModel: ChatLunaChatModel,
        searchTool: RecordingLivingMemorySearchTool,
        runLogger: LivingMemoryLogger
    ) {
        let modelCallCount = 0
        let exhaustedModelCalls = false
        const loggedModel = createLoggedModel(chatModel, {
            logger: runLogger,
            stage: 'agentic-decision',
            attempt: () => modelCallCount,
            fields: () => ({ modelCall: modelCallCount }),
            promptLogging: 'first',
            logResponseText: false
        })
        const toolAgent = createOpenAIAgent({
            llm: loggedModel,
            tools: [searchTool],
            prompt: agenticRecallPromptTemplate
        })

        const boundedAgent = RunnableLambda.from(
            async (
                input: ChainValues,
                runConfig?: RunnableConfig
            ): Promise<AgenticRecallDecision> => {
                modelCallCount += 1
                const isLastAllowedCall =
                    modelCallCount === agenticRecallMaxModelCalls
                if (isLastAllowedCall) {
                    exhaustedModelCalls = true
                }

                const decision = await toolAgent.invoke(
                    input as AgenticRecallToolAgentInput,
                    runConfig
                )
                if (
                    isLastAllowedCall &&
                    !Array.isArray(decision) &&
                    'returnValues' in decision
                ) {
                    exhaustedModelCalls = false
                }
                if (isLastAllowedCall && exhaustedModelCalls) {
                    throw new Error(agenticRecallExhaustedMessage)
                }
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
                    'Correct the tool name or arguments, then retry the tool call.'
                ].join(' ')
            },
            handleToolRuntimeErrors: (error) => {
                throw error
            }
        })
        return {
            runner,
            hasExhaustedModelCalls: () => exhaustedModelCalls
        }
    }

    private collectSearchResults(
        recordedSearchCalls: RecordedAgenticSearchCall[],
        intermediateSteps: AgentStep[] | undefined
    ) {
        const toolCallSummaries: AgenticMemorySearchToolCallSummary[] = []
        const matchedMemories: AgenticMemorySnapshotMemoryItem[] = []
        const orderedSearchCalls = orderRecordedSearchCalls(
            recordedSearchCalls,
            intermediateSteps
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

        return { toolCallSummaries, matchedMemories }
    }

}
