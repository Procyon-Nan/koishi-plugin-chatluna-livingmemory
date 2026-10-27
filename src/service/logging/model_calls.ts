import { randomUUID } from 'node:crypto'
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base'
import {
    coerceMessageLikeToMessage,
    isAIMessage,
    type BaseMessage
} from '@langchain/core/messages'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { stringifyModelContent, formatErrorDetails } from '../shared/utils'
import {
    formatLogScope,
    type LivingMemoryLogBlock,
    type LivingMemoryLogFields,
    type LivingMemoryLogger
} from './logger'

export interface LivingMemoryModelCallContext {
    logger: LivingMemoryLogger
    stage: string
    attempt: number | (() => number)
    fields?: LivingMemoryLogFields | (() => LivingMemoryLogFields)
    onCallId?: (modelCallId: string) => void
    onResponse?: (response: BaseMessage) => void
    promptLogging?: 'all' | 'first' | 'none'
    logResponseText?: boolean
}

const resolveFields = (
    fields: LivingMemoryModelCallContext['fields']
): LivingMemoryLogFields => {
    if (fields == null) {
        return {}
    }
    return typeof fields === 'function' ? fields() : fields
}

interface NormalizedMessage {
    role: string
    content: BaseMessage['content']
    name?: string
    toolCalls?: unknown
    invalidToolCalls?: unknown
    toolCallId?: unknown
}

const normalizeMessage = (message: BaseMessage): NormalizedMessage => {
    const candidate = message as BaseMessage & {
        name?: string
        tool_calls?: unknown
        invalid_tool_calls?: unknown
        tool_call_id?: unknown
    }
    return {
        role: message._getType(),
        name: candidate.name,
        content: message.content,
        toolCalls:
            candidate.tool_calls ?? message.additional_kwargs?.tool_calls,
        invalidToolCalls: candidate.invalid_tool_calls,
        toolCallId: candidate.tool_call_id
    }
}

const toMessages = (input: BaseLanguageModelInput): NormalizedMessage[] => {
    if (Array.isArray(input)) {
        return input.map((message) =>
            normalizeMessage(coerceMessageLikeToMessage(message))
        )
    }
    if (typeof input === 'string') {
        return [{ role: 'text', content: input }]
    }
    const prompt = input.toChatMessages()
    return prompt.map(normalizeMessage)
}

const messageRoleLabels: Record<string, string> = {
    system: '系统消息',
    human: '用户消息',
    ai: '助手消息',
    tool: '工具消息',
    function: '函数消息',
    generic: '自定义消息',
    developer: '开发者消息',
    text: '文本输入'
}

const modelStageLabels: Record<string, string> = {
    'agentic-decision': '召回',
    'dream-decision': 'Dream',
    'dream-compression': 'Dream 上下文压缩',
    'memory-extraction': '记忆提取',
    'persona-card': '人设卡片',
    'user-profile': '人物画像'
}

const formatModelLogDetails = (
    fields: LivingMemoryLogFields,
    callNumber?: number
) => {
    const details = [`模型：${fields.model}`]
    if (callNumber !== undefined) {
        details.push(`调用序号：${callNumber}`)
    }
    const scope = formatLogScope(fields)
    if (scope) details.push(scope)
    return details.join('; ')
}

const toPromptBlocks = (input: BaseLanguageModelInput) => {
    const blocks: LivingMemoryLogBlock[] = []
    for (const message of toMessages(input)) {
        const title = messageRoleLabels[message.role] ?? message.role
        blocks.push({
            title,
            fields: {
                名称: message.name,
                工具调用ID: message.toolCallId
            },
            key: 'content',
            value: message.content
        })
        if (message.toolCalls !== undefined) {
            blocks.push({
                title: `${title}的工具调用`,
                key: 'toolCalls',
                value: message.toolCalls
            })
        }
        if (message.invalidToolCalls !== undefined) {
            blocks.push({
                title: `${title}的无效工具调用`,
                key: 'invalidToolCalls',
                value: message.invalidToolCalls
            })
        }
    }
    return blocks
}

const toResponseBlocks = (response: BaseMessage, logResponseText: boolean) => {
    const blocks: LivingMemoryLogBlock[] = []
    if (logResponseText) {
        const text = stringifyModelContent(response.content)
        if (text.length > 0) {
            blocks.push({ title: '模型文本', key: 'text', value: text })
        }
    }
    if (isAIMessage(response)) {
        for (const call of response.tool_calls ?? []) {
            blocks.push({
                title: '工具调用',
                subtitle:
                    call.id == null ? call.name : `${call.name}:${call.id}`,
                key: 'args',
                value: call.args
            })
        }
    }
    return blocks
}

export const invokeLoggedModel = async (
    model: ChatLunaChatModel,
    input: BaseLanguageModelInput,
    runConfig: Parameters<ChatLunaChatModel['invoke']>[1],
    context: LivingMemoryModelCallContext
) => {
    return invokeLoggedRunnable(
        model,
        model.modelName,
        input,
        runConfig,
        context
    )
}

const invokeLoggedRunnable = async (
    runnable: Pick<ChatLunaChatModel, 'invoke'>,
    modelName: string,
    input: BaseLanguageModelInput,
    runConfig: Parameters<ChatLunaChatModel['invoke']>[1],
    context: LivingMemoryModelCallContext
) => {
    const modelCallId = randomUUID()
    context.onCallId?.(modelCallId)
    const attempt =
        typeof context.attempt === 'function'
            ? context.attempt()
            : context.attempt
    const logger = context.logger.with({
        ...resolveFields(context.fields),
        modelCallId,
        stage: context.stage,
        attempt,
        model: modelName
    })
    const stage = modelStageLabels[context.stage] ?? context.stage
    const promptLogging = context.promptLogging ?? 'all'
    const logPrompt =
        promptLogging === 'all' || (promptLogging === 'first' && attempt === 1)
    if (logPrompt) {
        logger.diagnosticSummary((fields) => ({
            event: `${stage}模型输入`,
            detail: formatModelLogDetails(
                fields,
                promptLogging === 'all' ? attempt : undefined
            ),
            blocks: toPromptBlocks(input)
        }))
    }
    const startedAt = performance.now()
    logger.diagnosticSummary((fields) => ({
        event: `${stage}模型调用`,
        detail: formatModelLogDetails(fields, attempt)
    }))
    try {
        const response = await runnable.invoke(input, runConfig)
        context.onResponse?.(response)
        logger.diagnosticSummary((fields) => {
            const blocks = toResponseBlocks(
                response,
                context.logResponseText ?? true
            )
            if (blocks.length === 0) return
            return {
                event: `${stage}模型响应`,
                detail: formatModelLogDetails(fields),
                blocks
            }
        })
        return response
    } catch (error) {
        logger.diagnostic('model.failed', () => ({
            elapsedMs: performance.now() - startedAt,
            error: formatErrorDetails(error)
        }))
        throw error
    }
}

export const createLoggedModel = (
    model: ChatLunaChatModel,
    context: LivingMemoryModelCallContext
) => {
    return {
        withConfig: (config: RunnableConfig) => {
            const boundModel = model.withConfig(config)
            type ModelInput = Parameters<ChatLunaChatModel['invoke']>[0]
            return RunnableLambda.from(
                async (input: ModelInput, runConfig?: RunnableConfig) =>
                    await invokeLoggedRunnable(
                        boundModel,
                        model.modelName,
                        input,
                        runConfig,
                        context
                    )
            )
        }
    } as unknown as ChatLunaChatModel
}
