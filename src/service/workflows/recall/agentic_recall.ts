import { isDirectToolOutput } from '@langchain/core/messages/tool'
import { OutputParserException } from '@langchain/core/output_parsers'
import {
    ChatPromptTemplate,
    MessagesPlaceholder
} from '@langchain/core/prompts'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'
import type { ChainValues } from '@langchain/core/utils/types'
import type { Context } from 'koishi'
import type { z } from 'zod'
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
    LivingMemorySearchResult,
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import { LivingMemoryMessageFormatter } from '../../transcript/message_formatter'
import { buildSnapshotRecallPrompts } from '../../prompts/agentic_recall'
import type { PromptMessages } from '../../prompts/prompt_format'
import { formatLogScope, type LivingMemoryLogger } from '../../logging/logger'
import { createLoggedModel } from '../../logging/model_calls'
import {
    memorySearchTool,
    memoryPassTool,
    memoryUpdateSnapshotTool
} from '../../prompts/memory_tools'
import { MemoryInputError } from '../../memory/errors'
import { createMemoryTool } from '../../memory/tools'
import type { LivingMemorySearchTool } from '../../memory/tools/search_memory_tool'
import { resolveScopeAssistantLabel } from '../../memory/helpers'
import type { LivingMemorySearchEngine } from './memory_search_engine'

type LivingMemoryAgenticRecallConfig = Pick<
    LivingMemoryConfig,
    | 'snapshotMaxLines'
    | 'subModel'
    | 'memorySearchToolMaxResults'
    | 'enableConversationIsolation'
>

interface RecordedAgenticSearchCall {
    input: z.infer<typeof memorySearchTool.schema>
    results: LivingMemorySearchResult[]
}

type AgenticRecallDecision = AgentAction | AgentAction[] | AgentFinish

type AgenticRecallToolAgentInput = ChainValues & {
    steps: AgentStep[]
    scratchpadEntries?: ScratchpadEntry[]
}

const agenticRecallMaxModelCalls = 6
const agenticRecallExhaustedMessage = `agentic recall did not finish within ${agenticRecallMaxModelCalls} model calls`

const agenticRecallPromptTemplate = ChatPromptTemplate.fromMessages([
    ['system', '{systemPrompt}'],
    ['human', '{inputPrompt}'],
    new MessagesPlaceholder('agent_scratchpad')
])

const aggregateToolCallSummary = (
    calls: RecordedAgenticSearchCall[],
    maxCandidates: number
): AgenticMemorySearchToolCallSummary => ({
    searchTexts: [...new Set(calls.flatMap(({ input }) => input.searchTexts))],
    searchKeywords: [
        ...new Set(calls.flatMap(({ input }) => input.searchKeywords ?? []))
    ],
    maxCandidates
})

const toSnapshotMemoryItem = (
    result: LivingMemorySearchResult
): AgenticMemorySnapshotMemoryItem => ({
    type: result.type,
    content: result.content,
    keywords: [...result.keywords],
    summary: result.summary,
    sentiment: result.sentiment,
    importance: result.importance,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt
})

const uniqueSnapshotMemoryItems = (
    results: LivingMemorySearchResult[]
): AgenticMemorySnapshotMemoryItem[] => {
    const seen = new Set<string>()
    const items: AgenticMemorySnapshotMemoryItem[] = []

    for (const result of results) {
        if (seen.has(result.id)) {
            continue
        }

        seen.add(result.id)
        items.push(toSnapshotMemoryItem(result))
    }

    return items
}

class RecordingLivingMemorySearchTool extends StructuredTool {
    name = memorySearchTool.name
    description = memorySearchTool.description
    schema = memorySearchTool.schema

    constructor(
        private readonly delegate: LivingMemorySearchTool,
        private readonly calls: RecordedAgenticSearchCall[],
        private readonly logger: LivingMemoryLogger
    ) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: z.infer<typeof memorySearchTool.schema>,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const { results, output } = await this.delegate.runSearch(
            input,
            runConfig
        )
        this.calls.push({ input, results })
        this.logger.diagnosticSummary((fields) => ({
            event: '记忆搜索完成',
            detail: `${formatLogScope(fields)}; 结果：当前检索条件下匹配 ${results.length} 条记忆`,
            blocks:
                results.length > 0
                    ? [{ title: '搜索结果', key: 'memories', value: output }]
                    : []
        }))
        return output
    }
}

export class LivingMemoryAgenticRecallExecutor {
    private readonly formatter = new LivingMemoryMessageFormatter()

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryAgenticRecallConfig,
        private readonly searchEngine: LivingMemorySearchEngine,
        private readonly logger: LivingMemoryLogger
    ) {}

    async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[],
        snapshotLines: readonly string[],
        saveSnapshot: (item: AgenticMemorySnapshotItem) => Promise<void>,
        runLogger: LivingMemoryLogger = this.logger
    ): Promise<AgenticMemorySnapshotItem | null> {
        const chatModel = await this.resolveChatModel()

        const prompt = this.buildRecallPrompt(
            scope,
            currentMessage,
            historyMessages,
            snapshotLines
        )
        const agentContext = {
            conversationId: scope.conversationId,
            requestId: [
                'agentic-recall',
                scope.presetId,
                scope.conversationId,
                Date.now()
            ].join(':')
        }
        const recordedSearchCalls: RecordedAgenticSearchCall[] = []
        const searchTool = new RecordingLivingMemorySearchTool(
            createMemoryTool.search(
                this.searchEngine,
                false,
                this.config.enableConversationIsolation
            ),
            recordedSearchCalls,
            runLogger
        )
        let savedSnapshot: AgenticMemorySnapshotItem | null = null
        const updateTool = createMemoryTool.updateSnapshot(
            snapshotLines,
            this.config.snapshotMaxLines,
            async (finalText) => {
                const item: AgenticMemorySnapshotItem = {
                    finalText,
                    toolCallSummary: aggregateToolCallSummary(
                        recordedSearchCalls,
                        this.config.memorySearchToolMaxResults
                    ),
                    matchedMemories: uniqueSnapshotMemoryItems(
                        recordedSearchCalls.flatMap((call) => call.results)
                    )
                }
                await saveSnapshot(item)
                savedSnapshot = item
            }
        )
        const runner = this.createBoundedAgentRunner(
            chatModel,
            [searchTool, updateTool, createMemoryTool.pass()],
            runLogger
        )

        const result = await runner.invoke(
            {
                systemPrompt: prompt.systemPrompt,
                inputPrompt: prompt.inputPrompt
            },
            {
                configurable: {
                    // 模型由 toolAgent 持有，避免宿主在结束工具后额外调用模型压缩历史。
                    preset: scope.presetId,
                    userId: scope.userId,
                    source: 'agentic-recall',
                    agentContext
                }
            }
        )
        const steps = result.intermediateSteps!
        if (!isDirectToolOutput(steps.at(-1)?.observation)) {
            throw new Error(agenticRecallExhaustedMessage)
        }
        return savedSnapshot
    }

    private async resolveChatModel(): Promise<ChatLunaChatModel> {
        const model = await this.ctx.chatluna.createChatModel(
            this.config.subModel
        )
        const chatModel = model.value
        if (chatModel == null) {
            throw new Error('subModel is unavailable.')
        }
        return chatModel
    }

    private buildRecallPrompt(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[],
        snapshotLines: readonly string[]
    ): PromptMessages {
        const assistantLabel = resolveScopeAssistantLabel(scope)
        const lastMessage = this.formatter.toExtractionPayload([
            currentMessage
        ]).input
        const chatHistory =
            this.formatter.toExtractionPayload(historyMessages).input
        return buildSnapshotRecallPrompts({
            assistantLabel,
            lastMessage,
            chatHistory,
            snapshotLines,
            snapshotMaxLines: this.config.snapshotMaxLines
        })
    }

    private createBoundedAgentRunner(
        chatModel: ChatLunaChatModel,
        tools: StructuredTool[],
        runLogger: LivingMemoryLogger
    ) {
        let modelCallCount = 0
        const loggedModel = createLoggedModel(chatModel, {
            logger: runLogger,
            stage: 'agentic-decision',
            attempt: () => modelCallCount,
            promptLogging: 'first',
            logResponseText: false
        })
        const toolAgent = createOpenAIAgent({
            llm: loggedModel,
            tools,
            prompt: agenticRecallPromptTemplate
        })

        const boundedAgent = RunnableLambda.from(
            async (
                input: ChainValues,
                runConfig?: RunnableConfig
            ): Promise<AgenticRecallDecision> => {
                modelCallCount += 1
                const decision = await toolAgent.invoke(
                    input as AgenticRecallToolAgentInput,
                    runConfig
                )
                if (!Array.isArray(decision) && 'returnValues' in decision) {
                    throw new OutputParserException(
                        `请调用 ${memoryUpdateSnapshotTool.name} 或 ${memoryPassTool.name} 完成本轮。`
                    )
                }
                const actions = Array.isArray(decision) ? decision : [decision]
                if (actions.length !== 1) {
                    throw new OutputParserException(
                        '每次只调用一个工具，根据工具返回结果决定下一步操作，请重新提交。'
                    )
                }
                return decision
            }
        )
        return AgentRunner.fromAgentAndTools({
            agent: boundedAgent,
            tools,
            maxIterations: agenticRecallMaxModelCalls,
            returnIntermediateSteps: true,
            handleParsingErrors: (error) => {
                return [
                    `Invalid tool call: ${error.message}`,
                    'Correct the tool name or arguments, then retry the tool call.'
                ].join(' ')
            },
            handleToolRuntimeErrors: (error) => {
                if (error instanceof MemoryInputError) return error.message
                throw error
            }
        })
    }
}
