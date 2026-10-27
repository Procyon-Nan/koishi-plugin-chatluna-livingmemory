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
import {
    ToolInputParsingException,
    type StructuredTool
} from '@langchain/core/tools'
import { isRequestFailure } from 'koishi-plugin-chatluna/utils/error'
import type { DreamBatch } from '../types'
import type { refreshIncrementalDreamBatch } from '../incremental'
import { MemoryInputError } from '../../../memory/errors'
import { isOutputParserException } from '../../structured_output'
import { createOpenAIAgent } from 'koishi-plugin-chatluna/llm-core/agent'
import type { AgentAction } from 'koishi-plugin-chatluna/llm-core/agent'
import type {
    ChatLunaChatModel,
    ChatLunaModelCallOptions
} from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { PresetSpeakerRecord } from '../../../../contracts/memory'
import {
    formatLogScope,
    type LivingMemoryLogger
} from '../../../logging/logger'
import { createLoggedModel } from '../../../logging/model_calls'
import {
    buildDreamMemoryBatchPrompt,
    buildDreamTurnFeedbackPrompt,
    buildDreamSystemPrompt
} from '../../../prompts/dream'
import { formatErrorDetails } from '../../../shared/utils'
import { DreamSessionHistory, dreamCompressionThreshold } from './history'
import {
    advanceDreamBatch,
    pendingDreamMemoryIds,
    recordSkippedDreamBatch,
    recordDreamProfileSpeakers,
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
    loadBatch?: (
        batch: DreamBatch
    ) => ReturnType<typeof refreshIncrementalDreamBatch>
}

export function createDreamCallOptions(
    model: ChatLunaChatModel,
    sessionId: string
) {
    const maxTokenLimit = model.getModelMaxContextSize()
    if (maxTokenLimit < dreamCompressionThreshold) {
        throw new Error('Dream 模型最大上下文须至少为 200k tokens。')
    }
    return {
        id: sessionId,
        stream: false,
        maxTokenLimit
    } satisfies ChatLunaModelCallOptions
}

export async function runDreamSession(input: DreamSessionRunInput) {
    const { state, model, tools, logger, signal, callOptions } = input
    signal?.throwIfAborted()
    const systemPrompt = buildDreamSystemPrompt(
        input.assistantLabel,
        input.presetPrompt
    )
    const history = new DreamSessionHistory(
        systemPrompt,
        model,
        callOptions,
        logger
    )
    logger.diagnosticSummary((fields) => ({
        event: 'Dream 会话开始',
        detail: formatLogScope(fields),
        blocks: [{ title: '系统消息', value: systemPrompt }]
    }))
    let modelCalls = 0
    let round = 0
    let response: BaseMessage | undefined
    const agent = createOpenAIAgent({
        llm: createLoggedModel(model, {
            logger,
            stage: 'dream-decision',
            attempt: () => modelCalls,
            promptLogging: 'none',
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
    const progress = (feedback: string) => {
        const content = buildDreamTurnFeedbackPrompt(
            pendingDreamMemoryIds(state),
            feedback
        )
        history.append(new HumanMessage(content))
        logger.diagnosticSummary((fields) => ({
            event: 'Dream 处理反馈',
            detail: `${formatLogScope(fields)}; 批次：${state.currentBatch!.id}; 轮次：${round}`,
            blocks: [{ title: '用户消息', value: content }]
        }))
    }

    while (advanceDreamBatch(state) !== undefined) {
        signal?.throwIfAborted()
        let speakers = input.speakers
        if (input.loadBatch) {
            const refreshed = await input.loadBatch(state.currentBatch!)
            signal?.throwIfAborted()
            if (refreshed === undefined) {
                state.untouchedSeedIds.push(state.currentBatch!.seedMemoryId!)
                state.currentBatch = undefined
                continue
            }
            state.currentBatch = {
                ...state.currentBatch!,
                entries: refreshed.entries
            }
            state.availableMemoryIds = new Set(
                refreshed.entries.map((entry) => entry.id)
            )
            speakers = refreshed.speakers
        }
        const batch = state.currentBatch!
        recordDreamProfileSpeakers(
            state,
            batch.entries.flatMap((entry) => entry.speakerKeys)
        )
        const batchLogger = logger.with({ batch: batch.id })
        const batchStartedAt = performance.now()
        const batchPrompt = buildDreamMemoryBatchPrompt(batch, speakers)
        history.startBatch(batchPrompt)
        batchLogger.diagnosticSummary((fields) => ({
            event: 'Dream 批次开始',
            detail: `${formatLogScope(fields)}; 批次：${batch.id}; 总批次：${state.batches.length}; 记忆：${batch.entries.length} 条`,
            blocks: [{ title: '用户消息', value: batchPrompt }]
        }))
        let ineffectiveRounds = 0
        for (round = 1; round <= maxBatchRounds; round++) {
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
                if (!isRequestFailure(error) && !isOutputParserException(error))
                    throw error
                feedback = `本轮模型请求或工具参数解析失败：${formatErrorDetails(error)}`
                const rejected = response as BaseMessage | undefined
                if (rejected !== undefined) {
                    // 无法解析的调用不能重放为协议消息，否则部分 adapter 会再次解析失败。
                    // 将原始响应作为转义后的纠错数据保留，不伪造已执行的工具结果。
                    feedback += `\n未执行的模型响应：${JSON.stringify(rejected.toDict())}`
                }
                logger.diagnosticSummary((fields) => ({
                    event: 'Dream 本轮处理失败',
                    detail: `${formatLogScope(fields)}; 批次：${state.currentBatch!.id}; 轮次：${round}; 原因：${formatErrorDetails(error)}`
                }))
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
                        const toolStartedAt = performance.now()
                        try {
                            const tool = tools.find(
                                (candidate) => candidate.name === action.tool
                            )
                            if (tool === undefined) {
                                throw new MemoryInputError(
                                    `未知工具：${action.tool}`
                                )
                            }
                            observation = await tool.invoke(
                                action.toolInput,
                                config
                            )
                            effective = true
                            batchLogger.diagnosticSummary((fields) => ({
                                event: 'Dream 工具执行完成',
                                detail: `${formatLogScope(fields)}; 批次：${batch.id}; 轮次：${round}; 耗时：${((performance.now() - toolStartedAt) / 1000).toFixed(3)} 秒`,
                                blocks: [
                                    {
                                        title: '工具结果',
                                        subtitle:
                                            'toolCallId' in action
                                                ? `${action.tool}:${action.toolCallId}`
                                                : action.tool,
                                        value: observation
                                    }
                                ]
                            }))
                        } catch (error) {
                            signal?.throwIfAborted()
                            if (
                                !(error instanceof ToolInputParsingException) &&
                                !(error instanceof MemoryInputError)
                            )
                                throw error
                            batchLogger.diagnosticSummary((fields) => ({
                                event: 'Dream 工具执行失败',
                                detail: `${formatLogScope(fields)}; 批次：${fields.batch}; 轮次：${round}; 工具：${action.tool}; 耗时：${((performance.now() - toolStartedAt) / 1000).toFixed(3)} 秒; 原因：${formatErrorDetails(error)}`
                            }))
                            observation = `工具执行失败：${formatErrorDetails(error)}。请修正后重试。`
                        }
                        history.append(toolResult(action, observation))
                    }
                }
            }
            signal?.throwIfAborted()
            const pending = pendingDreamMemoryIds(state)
            ineffectiveRounds = effective ? 0 : ineffectiveRounds + 1
            batchLogger.diagnosticSummary((fields) => ({
                event: 'Dream 本轮处理完成',
                detail: `${formatLogScope(fields)}; 批次：${batch.id}; 轮次：${round}; 已处理：${batch.entries.length - pending.length}/${batch.entries.length} 条; 连续无有效操作：${ineffectiveRounds} 轮`
            }))
            if (pending.length === 0) {
                batchLogger.summary(
                    'Dream 批次完成',
                    `${formatLogScope({ presetId: input.presetId })}; 批次：${batch.id}; 处理记忆：${batch.entries.length} 条; 轮次：${round}; 耗时：${((performance.now() - batchStartedAt) / 1000).toFixed(3)} 秒`
                )
                break
            }
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
                logger.summary(
                    'Dream 跳过批次剩余记忆',
                    `预设：${input.presetId}; 批次：${batch.id}; 原因：${reason}; 已处理：${batch.entries.length - pending.length}/${batch.entries.length} 条; 跳过：${pending.length} 条`,
                    'warn'
                )
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
