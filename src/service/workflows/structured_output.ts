import { HumanMessage } from '@langchain/core/messages'
import { OutputParserException } from '@langchain/core/output_parsers'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import {
    ChatPromptTemplate,
    MessagesPlaceholder
} from '@langchain/core/prompts'
import { tool } from '@langchain/core/tools'
import type { ChainValues } from '@langchain/core/utils/types'
import type { z } from 'zod'
import {
    type AgentAction,
    type AgentFinish,
    createOpenAIAgent,
    type ScratchpadEntry
} from 'koishi-plugin-chatluna/llm-core/agent'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { PromptMessages } from '../prompts/prompt_format'
import { summarizeError } from '../shared/utils'

const structuredOutputMaxModelCalls = 2
const outputParsingFailureCode = 'OUTPUT_PARSING_FAILURE'
const modelInvocationErrors = new WeakSet<object>()

const structuredOutputPromptTemplate = ChatPromptTemplate.fromMessages([
    ['system', '{systemPrompt}'],
    ['human', '{inputPrompt}'],
    new MessagesPlaceholder('agent_scratchpad')
])

type StructuredOutputDecision = AgentAction | AgentAction[] | AgentFinish
type StructuredOutputAgentInput = ChainValues & {
    steps: []
    scratchpadEntries: ScratchpadEntry[]
}

export interface StructuredOutputContext {
    presetId: string
    conversationId: string
}

export interface StructuredOutputResult<T> {
    value: T | null
    output: string
    parseError: string | null
}

interface StructuredOutputOptions<Schema extends z.AnyZodObject> {
    model: ChatLunaChatModel
    prompt: PromptMessages
    toolName: string
    toolDescription: string
    schema: Schema
    context: StructuredOutputContext
}

const toActions = (decision: StructuredOutputDecision): AgentAction[] => {
    if (Array.isArray(decision)) {
        return decision
    }

    return 'returnValues' in decision ? [] : [decision]
}

const formatDecision = (decision: StructuredOutputDecision) => {
    if (!Array.isArray(decision) && 'returnValues' in decision) {
        const output = decision.returnValues['output']
        return typeof output === 'string'
            ? output
            : (JSON.stringify(output, null, 2) ?? String(output ?? ''))
    }

    return JSON.stringify(
        toActions(decision).map((action) => ({
            tool: action.tool,
            arguments: action.toolInput
        })),
        null,
        2
    )
}

const formatSchemaError = (error: z.ZodError) => {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join('.') : 'root'
            return `${path}: ${issue.message}`
        })
        .join('; ')
}

const parseToolInput = (input: AgentAction['toolInput']) => {
    if (typeof input !== 'string') {
        return input
    }

    try {
        return JSON.parse(input) as unknown
    } catch {
        return input
    }
}

const validateDecision = <Schema extends z.AnyZodObject>(
    decision: StructuredOutputDecision,
    toolName: string,
    schema: Schema
):
    | { value: z.output<Schema>; error: null }
    | { value: null; error: string } => {
    const actions = toActions(decision)
    if (actions.length === 0) {
        return {
            value: null,
            error: `model finished without calling ${toolName}`
        }
    }

    if (actions.length !== 1) {
        return {
            value: null,
            error: `${toolName} must be called exactly once; received ${actions.length} tool calls`
        }
    }

    const action = actions[0]
    if (action.tool !== toolName) {
        return {
            value: null,
            error: `unexpected tool call ${action.tool}; expected ${toolName}`
        }
    }

    const parsed = schema.safeParse(parseToolInput(action.toolInput))
    if (!parsed.success) {
        return {
            value: null,
            error: `invalid ${toolName} arguments: ${formatSchemaError(parsed.error)}`
        }
    }

    return { value: parsed.data, error: null }
}

const createRetryEntries = (
    decision: StructuredOutputDecision | null,
    toolName: string,
    error: string
): ScratchpadEntry[] => {
    const correction = [
        `结构化结果无效：${error}。`,
        `必须且只能调用 ${toolName} 一次，并完整修正工具参数。`,
        '不要在普通文本中输出结果。'
    ].join(' ')
    const actions = decision == null ? [] : toActions(decision)

    if (actions.length > 0) {
        return actions.map((action) => ({
            action,
            observation: correction
        }))
    }

    return [
        {
            type: 'human_update',
            messages: [new HumanMessage(correction)]
        }
    ]
}

const isOutputParserException = (
    error: unknown
): error is OutputParserException => {
    return (
        error instanceof OutputParserException ||
        (error instanceof Error &&
            'lc_error_code' in error &&
            error.lc_error_code === outputParsingFailureCode)
    )
}

const markModelInvocationError = (error: unknown): never => {
    const markedError =
        (typeof error === 'object' && error != null) ||
        typeof error === 'function'
            ? error
            : new Error(String(error))
    modelInvocationErrors.add(markedError)
    throw markedError
}

export const isStructuredOutputModelInvocationError = (error: unknown) => {
    return (
        ((typeof error === 'object' && error != null) ||
            typeof error === 'function') &&
        modelInvocationErrors.has(error)
    )
}

const guardModelInvocations = (model: ChatLunaChatModel) => {
    return {
        withConfig: (config: RunnableConfig) => {
            const boundModel = model.withConfig(config)
            type BoundModelInput = Parameters<typeof boundModel.invoke>[0]

            return RunnableLambda.from(
                async (input: BoundModelInput, runConfig?: RunnableConfig) => {
                    try {
                        return await boundModel.invoke(input, runConfig)
                    } catch (error) {
                        return markModelInvocationError(error)
                    }
                }
            )
        }
    } as unknown as ChatLunaChatModel
}

export async function invokeStructuredOutput<Schema extends z.AnyZodObject>(
    options: StructuredOutputOptions<Schema>
): Promise<StructuredOutputResult<z.output<Schema>>> {
    const resultTool = tool(async (input) => JSON.stringify(input), {
        name: options.toolName,
        description: options.toolDescription,
        schema: options.schema
    })
    const agent = createOpenAIAgent({
        llm: guardModelInvocations(options.model),
        tools: [resultTool],
        prompt: structuredOutputPromptTemplate
    })
    const outputs: string[] = []
    let scratchpadEntries: ScratchpadEntry[] = []
    let lastError = 'structured output failed'

    for (let attempt = 1; attempt <= structuredOutputMaxModelCalls; attempt++) {
        let decision: StructuredOutputDecision | null = null

        try {
            decision = await agent.invoke(
                {
                    systemPrompt: options.prompt.systemPrompt,
                    inputPrompt: options.prompt.inputPrompt,
                    steps: [],
                    scratchpadEntries
                } as StructuredOutputAgentInput,
                {
                    configurable: {
                        model: options.model,
                        preset: options.context.presetId,
                        conversationId: options.context.conversationId
                    }
                }
            )
            outputs.push(`[attempt ${attempt}]\n${formatDecision(decision)}`)

            const validated = validateDecision(
                decision,
                options.toolName,
                options.schema
            )
            if (validated.error == null) {
                return {
                    value: validated.value,
                    output: outputs.join('\n\n'),
                    parseError: null
                }
            }

            lastError = validated.error
        } catch (error) {
            if (isStructuredOutputModelInvocationError(error)) {
                throw error
            }

            lastError = summarizeError(error)
            const rawOutput =
                isOutputParserException(error) &&
                typeof error.llmOutput === 'string' &&
                error.llmOutput.length > 0
                    ? error.llmOutput
                    : lastError
            outputs.push(`[attempt ${attempt}]\n${rawOutput}`)
        }

        scratchpadEntries = createRetryEntries(
            decision,
            options.toolName,
            lastError
        )
    }

    return {
        value: null,
        output: outputs.join('\n\n'),
        parseError: lastError
    }
}
