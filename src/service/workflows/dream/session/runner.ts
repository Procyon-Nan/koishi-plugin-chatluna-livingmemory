import {
    FunctionMessage,
    HumanMessage,
    ToolMessage,
    type BaseMessage
} from '@langchain/core/messages'
import {
    ChatPromptTemplate,
    MessagesPlaceholder
} from '@langchain/core/prompts'
import type { StructuredTool } from '@langchain/core/tools'
import { createOpenAIAgent } from 'koishi-plugin-chatluna/llm-core/agent'
import type { AgentAction } from 'koishi-plugin-chatluna/llm-core/agent'
import type {
    ChatLunaChatModel,
    ChatLunaModelCallOptions
} from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { PresetSpeakerRecord } from '../../../../contracts/memory'
import type { LivingMemoryLogger } from '../../../logging/logger'
import { createLoggedModel } from '../../../logging/model_calls'
import {
    buildDreamMemoryBatchPrompt,
    buildDreamTurnFeedbackPrompt,
    buildDreamSystemPrompt
} from '../../../prompts/dream'
import { summarizeError } from '../../../shared/utils'
import { LivingMemoryVectorIndexError } from '../../../vector_index/errors'
import { DreamSessionHistory, dreamCompressionThreshold } from './history'
import {
    advanceDreamBatch,
    pendingDreamMemoryIds,
    recordSkippedDreamBatch,
    type DreamSessionState
} from './state'

const maxBatchRounds = 60
const maxIneffectiveRounds = 3
const prompt = ChatPromptTemplate.fromMessages([
    new MessagesPlaceholder('history'),
    new MessagesPlaceholder('agent_scratchpad')
])

interface DreamSessionRunInput {
    presetId: string
    callOptions: ReturnType<typeof createDreamCallOptions>
    assistantLabel: string
    presetPrompt: string
    speakers: PresetSpeakerRecord[]
    state: DreamSessionState
    tools: StructuredTool[]
    model: ChatLunaChatModel
    logger: LivingMemoryLogger
    signal?: AbortSignal
}

export function createDreamCallOptions(
    model: ChatLunaChatModel,
    sessionId: string
) {
    const defaults = model.invocationParams()
    const requestedOutput = defaults.maxTokens
    const maxTokens =
        requestedOutput != null && requestedOutput > 0 ? requestedOutput : 4096
    const maxTokenLimit = model.getModelMaxContextSize() - maxTokens
    if (
        !Number.isFinite(maxTokenLimit) ||
        maxTokenLimit < dreamCompressionThreshold
    ) {
        throw new Error('Dream 模型须能容纳 200k 输入及输出预算。')
    }
    return {
        id: sessionId,
        stream: false,
        maxTokens,
        maxTokenLimit,
        overrideRequestParams: defaults.overrideRequestParams
    } satisfies ChatLunaModelCallOptions
}

export async function runDreamSession(input: DreamSessionRunInput) {
    const { state, model, tools, logger, signal, callOptions } = input
    signal?.throwIfAborted()
    const history = new DreamSessionHistory(
        buildDreamSystemPrompt(input.assistantLabel, input.presetPrompt),
        model,
        callOptions,
        logger
    )
    let modelCalls = 0
    let response: BaseMessage | undefined
    const agent = createOpenAIAgent({
        llm: createLoggedModel(model, {
            logger,
            stage: 'dream-decision',
            attempt: () => modelCalls,
            fields: () => ({ batch: state.currentBatch?.id }),
            promptLogging: 'first',
            onResponse: (message) => {
                response = message
                history.recordUsage(message)
            }
        }),
        tools,
        prompt
    })
    const config = {
        ...callOptions,
        signal,
        configurable: { preset: input.presetId }
    }
    const progress = (feedback: string) =>
        history.append(
            new HumanMessage(
                buildDreamTurnFeedbackPrompt(
                    pendingDreamMemoryIds(state),
                    feedback
                )
            )
        )

    while (advanceDreamBatch(state) !== undefined) {
        signal?.throwIfAborted()
        history.startBatch(
            buildDreamMemoryBatchPrompt(state.currentBatch!, input.speakers)
        )
        let ineffectiveRounds = 0
        for (let round = 1; round <= maxBatchRounds; round++) {
            const messages = await history.prepareDecisionMessages(
                tools,
                signal
            )
            modelCalls++
            response = undefined
            let effective = false
            let feedback = '请继续处理当前批次。'
            let decision: Awaited<ReturnType<typeof agent.invoke>> | undefined
            try {
                const agentInput = { history: messages, steps: [] }
                decision = await agent.invoke(agentInput, config)
            } catch (error) {
                signal?.throwIfAborted()
                feedback = `本轮模型请求或工具参数解析失败：${summarizeError(error)}`
                const rejected = response as BaseMessage | undefined
                if (rejected !== undefined) {
                    // 无法解析的调用不能重放为协议消息，否则部分 adapter 会再次解析失败。
                    // 将原始响应作为转义后的纠错数据保留，不伪造已执行的工具结果。
                    feedback += `\n未执行的模型响应：${JSON.stringify(rejected.toDict())}`
                }
                logger.diagnostic('dream.round.failed', {
                    batch: state.currentBatch!.id,
                    round,
                    error: summarizeError(error)
                })
            }
            signal?.throwIfAborted()
            if (decision !== undefined) {
                if (response !== undefined) history.append(response)
                if (!Array.isArray(decision) && 'returnValues' in decision) {
                    feedback =
                        '本批仍有待处理记忆，普通回答不能结束整理，请调用工具。'
                } else {
                    const actions = Array.isArray(decision)
                        ? decision
                        : [decision]
                    for (const action of actions) {
                        signal?.throwIfAborted()
                        if ('toolCallId' in action && !action.toolCallId) {
                            throw new Error(
                                '模型工具调用缺少 ID，无法继续配对会话。'
                            )
                        }
                        let observation: string
                        try {
                            const tool = tools.find(
                                (candidate) => candidate.name === action.tool
                            )
                            if (tool === undefined) {
                                throw new Error(`未知工具：${action.tool}`)
                            }
                            observation = await tool.invoke(
                                action.toolInput,
                                config
                            )
                            effective = true
                        } catch (error) {
                            signal?.throwIfAborted()
                            if (error instanceof LivingMemoryVectorIndexError)
                                throw error
                            observation = `工具执行失败：${summarizeError(error)}。请修正后重试。`
                        }
                        history.append(toolResult(action, observation))
                    }
                }
            }
            signal?.throwIfAborted()
            if (pendingDreamMemoryIds(state).length === 0) break
            ineffectiveRounds = effective ? 0 : ineffectiveRounds + 1
            if (
                ineffectiveRounds >= maxIneffectiveRounds ||
                round === maxBatchRounds
            ) {
                const reason =
                    ineffectiveRounds >= maxIneffectiveRounds
                        ? '连续 3 轮无有效操作'
                        : '达到每批 60 轮上限'
                recordSkippedDreamBatch(state, reason)
                progress(
                    `${feedback}\n${reason}，跳过本批剩余记忆并进入下一批。`
                )
                logger.diagnostic('dream.batch.skipped', {
                    batch: state.currentBatch!.id,
                    round,
                    reason,
                    memoryIds: pendingDreamMemoryIds(state)
                })
                break
            }
            progress(feedback)
        }
    }
}

function toolResult(action: AgentAction, content: string) {
    if ('toolCallId' in action) {
        return new ToolMessage({
            content,
            name: action.tool,
            tool_call_id: action.toolCallId as string
        })
    }
    return new FunctionMessage({ content, name: action.tool })
}
