import assert from 'node:assert/strict'
import {
    AIMessage,
    isToolMessage,
    type OpenAIToolCall
} from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { ChatLunaModelCallOptions } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { z } from 'zod'
import { invokeStructuredOutput } from '../src/service/workflows/structured_output'
import {
    createToolCallingModel,
    createToolCallMessage
} from './tool-calling-test-utils'

const toolName = 'submit_result'
const schema = z.object({
    items: z.array(z.string().trim().min(1)),
    note: z.string().optional()
})
const prompt = {
    systemPrompt: `只调用 ${toolName}。`,
    inputPrompt: '提交结果。'
}
const context = {
    presetId: 'preset-1',
    conversationId: 'conversation-1'
}

const boundTools = (
    runConfig: RunnableConfig | undefined
): NonNullable<ChatLunaModelCallOptions['tools']> =>
    (
        runConfig as
            | (RunnableConfig & Pick<ChatLunaModelCallOptions, 'tools'>)
            | undefined
    )?.tools ?? []

const invoke = (
    responses: Parameters<typeof createToolCallingModel>[0],
    validate?: (value: { items: string[]; note?: string }) => void
) => {
    const harness = createToolCallingModel(responses)
    return {
        harness,
        result: invokeStructuredOutput({
            model: harness.model,
            prompt,
            toolName,
            toolDescription: '提交测试结果。',
            schema,
            validateResult: validate,
            stringifiedArrayField: 'items',
            context
        })
    }
}

it('retries results rejected by contextual validation', async () => {
    const { harness, result } = invoke(
        [
            createToolCallMessage(toolName, { items: ['unknown'] }),
            createToolCallMessage(
                toolName,
                { items: ['corrected'] },
                'result-2'
            )
        ],
        ({ items }) => {
            if (items.includes('unknown')) {
                throw new Error('unknown item')
            }
        }
    )

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(harness.invocations.length, 2)
})

it('accepts one valid structured result tool call', async () => {
    const { harness, result } = invoke([
        createToolCallMessage(toolName, { items: ['alpha'] })
    ])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['alpha'] })
    assert.equal(resolved.parseError, null)
    assert.match(resolved.output, /^\[attempt 1\]/u)
    assert.match(resolved.output, /"tool": "submit_result"/u)
    assert.match(resolved.output, /"alpha"/u)
    assert.equal(harness.invocations.length, 1)
    const tools = boundTools(harness.bindings[0])
    assert.equal(tools[0]?.name, toolName)
})

it('decodes one whitelisted stringified array field without retry', async () => {
    const note = '["keep this as text"]'
    const { harness, result } = invoke([
        createToolCallMessage(toolName, {
            items: '["alpha"]',
            note
        })
    ])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['alpha'], note })
    assert.equal(resolved.parseError, null)
    assert.equal(harness.invocations.length, 1)
    assert.match(resolved.output, /\[attempt 1 normalization\]/u)
    assert.match(
        resolved.output,
        /decoded stringified JSON array field: items/u
    )
})

it('retries malformed stringified arrays with direct array guidance', async () => {
    const { harness, result } = invoke([
        createToolCallMessage(toolName, { items: '["broken"' }),
        createToolCallMessage(toolName, { items: ['corrected'] }, 'result-2')
    ])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(harness.invocations.length, 2)
    const retryMessages = harness.invocations[1]?.messages ?? []
    const toolMessage = retryMessages.find(
        (message) => message.getType() === 'tool'
    )
    assert.ok(String(toolMessage?.content).includes('正确 {"items":[]}'))
    assert.ok(String(toolMessage?.content).includes('错误 {"items":"[]"}'))
})

it('does not normalize stringified values that are not arrays', async () => {
    const { harness, result } = invoke([
        createToolCallMessage(toolName, { items: '"alpha"' }),
        createToolCallMessage(toolName, { items: ['corrected'] }, 'result-2')
    ])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(harness.invocations.length, 2)
    assert.doesNotMatch(resolved.output, /\[attempt 1 normalization\]/u)
})

it('retries once when the model finishes without the result tool', async () => {
    const { harness, result } = invoke([
        new AIMessage('普通文本结果'),
        createToolCallMessage(toolName, { items: ['corrected'] }, 'result-2')
    ])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(harness.invocations.length, 2)
    const retryMessages = harness.invocations[1]?.messages ?? []
    assert.equal(retryMessages.at(-1)?.getType(), 'human')
    assert.match(String(retryMessages.at(-1)?.content), /必须且只能调用/u)
})

it('feeds schema errors back through the tool-call scratchpad', async () => {
    const { harness, result } = invoke([
        createToolCallMessage(toolName, { items: [1] }),
        createToolCallMessage(toolName, { items: ['corrected'] }, 'result-2')
    ])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    const retryMessages = harness.invocations[1]?.messages ?? []
    const toolMessage = retryMessages.find(isToolMessage)
    assert.match(String(toolMessage?.content), /items\.0/u)
    assert.equal(toolMessage?.tool_call_id, 'result-1')
})

it('retries malformed legacy tool arguments once', async () => {
    const malformedToolCall: OpenAIToolCall = {
        id: 'result-1',
        type: 'function',
        function: {
            name: toolName,
            arguments: '{"items":["truncated"]'
        }
    }
    const malformed = new AIMessage({
        content: '',
        additional_kwargs: {
            tool_calls: [malformedToolCall]
        }
    })
    const { harness, result } = invoke([
        malformed,
        createToolCallMessage(toolName, { items: ['corrected'] }, 'result-2')
    ])

    const resolved = await result

    assert.deepEqual(resolved.value, { items: ['corrected'] })
    assert.equal(resolved.parseError, null)
    assert.equal(harness.invocations.length, 2)
    assert.match(resolved.output, /^\[attempt 1\][\s\S]*\n\n\[attempt 2\]/u)
})

it('propagates model invocation errors without a correction retry', async () => {
    const failure = new Error('model request failed')
    const { harness, result } = invoke([failure])

    await assert.rejects(result, (error) => error === failure)
    assert.equal(harness.invocations.length, 1)
})

it('returns a parse error after three invalid structured responses', async () => {
    const { harness, result } = invoke([
        new AIMessage('第一次普通文本结果'),
        new AIMessage('第二次普通文本结果'),
        new AIMessage('第三次普通文本结果')
    ])

    const resolved = await result

    assert.equal(resolved.value, null)
    assert.match(resolved.parseError ?? '', /without calling submit_result/u)
    assert.equal(harness.invocations.length, 3)
})
