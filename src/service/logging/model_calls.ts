import { randomUUID } from 'node:crypto'
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base'
import type { BaseMessage } from '@langchain/core/messages'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { stringifyModelContent, summarizeError } from '../shared/utils'
import type { LivingMemoryLogFields, LivingMemoryLogger } from './logger'

export interface LivingMemoryModelCallContext {
    logger: LivingMemoryLogger
    stage: string
    attempt: number | (() => number)
    fields?: LivingMemoryLogFields | (() => LivingMemoryLogFields)
    onCallId?: (modelCallId: string) => void
}

const resolveFields = (
    fields: LivingMemoryModelCallContext['fields']
): LivingMemoryLogFields => {
    if (fields == null) {
        return {}
    }
    return typeof fields === 'function' ? fields() : fields
}

const messageType = (message: BaseMessage) => {
    try {
        return message._getType()
    } catch {
        return message.constructor.name
    }
}

const normalizeMessage = (message: BaseMessage) => {
    const candidate = message as BaseMessage & {
        name?: string
        tool_calls?: unknown
        invalid_tool_calls?: unknown
        tool_call_id?: unknown
    }
    return {
        role: messageType(message),
        name: candidate.name,
        content: message.content,
        toolCalls:
            candidate.tool_calls ?? message.additional_kwargs?.tool_calls,
        invalidToolCalls: candidate.invalid_tool_calls,
        toolCallId: candidate.tool_call_id
    }
}

const toMessages = (input: BaseLanguageModelInput) => {
    if (Array.isArray(input)) {
        return input.map((message) => normalizeMessage(message as BaseMessage))
    }
    if (typeof input === 'string') {
        return [{ role: 'text', content: input }]
    }
    const prompt = input.toChatMessages()
    return prompt.map(normalizeMessage)
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
    logger.diagnostic('model.prompt', () => ({
        messages: toMessages(input)
    }))
    try {
        const response = await runnable.invoke(input, runConfig)
        logger.diagnostic('model.response', () => ({
            response,
            text: stringifyModelContent(response.content)
        }))
        return response
    } catch (error) {
        logger.diagnostic('model.failed', () => ({
            error: summarizeError(error)
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
