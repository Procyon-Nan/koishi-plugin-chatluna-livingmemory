import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'

export interface ToolCallingModelInvocation {
    messages: BaseMessage[]
    config?: RunnableConfig
}

const toMessages = (input: unknown): BaseMessage[] => {
    if (
        typeof input === 'object' &&
        input != null &&
        'toChatMessages' in input &&
        typeof input.toChatMessages === 'function'
    ) {
        return input.toChatMessages() as BaseMessage[]
    }

    return Array.isArray(input) ? (input as BaseMessage[]) : []
}

export const createToolCallMessage = (
    name: string,
    args: Record<string, unknown>,
    id = 'result-1'
) => {
    return new AIMessage({
        content: '',
        tool_calls: [
            {
                name,
                args,
                id,
                type: 'tool_call'
            }
        ]
    })
}

export const createToolCallingModel = (
    responses: (BaseMessage | Error)[]
) => {
    const pending = [...responses]
    const invocations: ToolCallingModelInvocation[] = []
    const bindings: RunnableConfig[] = []
    const boundModel = RunnableLambda.from(
        async (input: unknown, config?: RunnableConfig) => {
            invocations.push({ messages: toMessages(input), config })
            const response = pending.shift()
            if (response == null) {
                throw new Error('missing fake model response')
            }
            if (response instanceof Error) {
                throw response
            }
            return response
        }
    )
    const model = {
        withConfig: (config: RunnableConfig) => {
            bindings.push(config)
            return boundModel
        }
    } as unknown as ChatLunaChatModel

    return { bindings, invocations, model }
}
