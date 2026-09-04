import assert from 'node:assert/strict'
import {
    AIMessage,
    isToolMessage,
    type BaseMessage,
    type OpenAIToolCall
} from '@langchain/core/messages'
import type { ToolCall } from '@langchain/core/messages/tool'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import type { Context } from 'koishi'
import { LivingMemoryLogger } from '../src/service/logging/logger'
import type {
    ChatLunaChatModel
} from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    MemoryScope
} from '../src/contracts/memory'
import {
    livingMemorySearchToolName,
    type LivingMemorySearchToolInput
} from '../src/service/memory/tools/search_contract'
import { LivingMemoryAgenticRecallExecutor } from '../src/service/workflows/recall/agentic_recall'
import type { LivingMemoryEmbeddingSearchEngine } from '../src/service/workflows/recall/embedding_search_engine'
import { currentMessage, scope } from './workflow-test-utils'

interface ModelInvocation {
    messages: BaseMessage[]
    config?: RunnableConfig
}

interface SearchInvocation {
    presetId: string
    input: LivingMemorySearchInput
    maxCandidates: number
}

interface AgenticRecallHarnessOptions {
    responses: (BaseMessage | Error)[]
    search?: (
        invocation: SearchInvocation
    ) => Promise<LivingMemorySearchResult[]>
}

const config = {
    subModel: 'test/model',
    embeddingModel: 'test-embedding',
    debug: false,
    memorySearchToolMaxResults: 30,
    recallHistoryWindowRounds: 3
} as const

const testScope: MemoryScope = {
    ...scope,
    userId: 'user-1',
    presetLabel: '助手<&'
}

const validSearchInput = (text: string): LivingMemorySearchToolInput => ({
    searchTexts: [text]
})

const createSearchCall = (
    id: string,
    input: ToolCall['args'] = validSearchInput('记忆')
) => {
    return new AIMessage({
        content: '',
        tool_calls: [
            {
                name: livingMemorySearchToolName,
                args: input,
                id,
                type: 'tool_call'
            }
        ]
    })
}

const createMultipleSearchCalls = (
    calls: { id: string; input: LivingMemorySearchToolInput }[]
) => {
    return new AIMessage({
        content: '',
        tool_calls: calls.map((call) => ({
            name: livingMemorySearchToolName,
            args: call.input,
            id: call.id,
            type: 'tool_call' as const
        }))
    })
}

const createSearchResult = (id: string): LivingMemorySearchResult => ({
    id,
    type: 'fact',
    content: `content-${id}`,
    keywords: ['记忆'],
    summary: `summary-${id}`,
    sentiment: '平静',
    importance: 0.8,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z')
})

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

const createHarness = (options: AgenticRecallHarnessOptions) => {
    const responses = [...options.responses]
    const boundInvocations: ModelInvocation[] = []
    const searchInvocations: SearchInvocation[] = []

    const takeResponse = (response: BaseMessage | Error | undefined) => {
        if (response == null) {
            throw new Error('missing fake model response')
        }
        if (response instanceof Error) {
            throw response
        }
        return response
    }

    const boundModel = RunnableLambda.from(
        async (input: unknown, runConfig?: RunnableConfig) => {
            boundInvocations.push({
                messages: toMessages(input),
                config: runConfig
            })
            return takeResponse(responses.shift())
        }
    )
    const model = {
        withConfig: () => boundModel,
        invoke: async () => {
            throw new Error('unexpected direct model invocation')
        }
    } as unknown as ChatLunaChatModel
    const mockEngine = {
        searchMemories: async (
            presetId: string,
            input: LivingMemorySearchInput
        ) => {
            const invocation: SearchInvocation = {
                presetId,
                input: { ...input },
                maxCandidates: config.memorySearchToolMaxResults
            }
            searchInvocations.push(invocation)
            return await (options.search?.(invocation) ?? [])
        }
    } as unknown as LivingMemoryEmbeddingSearchEngine
    const context = {
        chatluna: {
            createChatModel: async () => ({ value: model })
        },
        logger: () => ({ info: () => {}, warn: () => {} })
    } as unknown as Context
    const debugMessages: string[] = []
    const executor = new LivingMemoryAgenticRecallExecutor(
        context,
        config,
        mockEngine,
        new LivingMemoryLogger(
            {
                info: (message: unknown) => debugMessages.push(String(message)),
                warn: () => {},
                error: () => {}
            } as never,
            () => true
        )
    )

    return {
        boundInvocations,
        debugMessages,
        searchInvocations,
        run: () => executor.run(testScope, currentMessage, [])
    }
}

const toolMessages = (invocation: ModelInvocation | undefined) => {
    return invocation?.messages.filter(isToolMessage) ?? []
}

it('runs one search through AgentRunner and preserves preset-scoped trace data', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1'),
            new AIMessage('我记得一段可靠的往事。')
        ],
        search: async () => [createSearchResult('memory-1')]
    })

    const trace = await harness.run()

    assert.ok(trace)
    assert.equal(trace.item.finalText, '我记得一段可靠的往事。')
    assert.equal(trace.item.matchedMemories.length, 1)
    assert.equal(trace.item.matchedMemories[0]?.content, 'content-memory-1')
    assert.deepEqual(trace.item.toolCallSummary.searchTexts, ['记忆'])
    assert.equal(harness.searchInvocations[0]?.presetId, scope.presetId)
    assert.deepEqual(harness.searchInvocations[0]?.input.memoryTypes, ['all'])
    assert.equal(harness.boundInvocations.length, 2)
    assert.deepEqual(
        harness.boundInvocations[0]?.messages.map((message) =>
            message.getType()
        ),
        ['system', 'human']
    )
    assert.match(
        String(harness.boundInvocations[0]?.messages[0]?.content),
        /<tool_policy>/u
    )
    assert.match(
        String(harness.boundInvocations[0]?.messages[0]?.content),
        /你是助手&lt;&amp;/u
    )
    assert.doesNotMatch(
        String(harness.boundInvocations[0]?.messages[0]?.content),
        /你是preset-1/u
    )
    assert.match(
        String(harness.boundInvocations[0]?.messages[1]?.content),
        /<agentic_recall_input>/u
    )
    assert.ok(trace.prompt.systemPrompt.length > 0)
    assert.ok(trace.prompt.inputPrompt.length > 0)
    assert.equal(
        String(toolMessages(harness.boundInvocations[1])[0]?.content),
        [
            'type=fact',
            'updatedAt=2026-07-01T00:00:00.000Z',
            'sentiment=平静',
            'content:',
            'content-memory-1'
        ].join('\n')
    )
    assert.ok(
        harness.debugMessages.some(
            (message) =>
                message.includes('event=model.response') &&
                message.includes('response.tool_calls')
        )
    )
    assert.equal(
        harness.debugMessages.filter((message) =>
            message.includes('event=model.prompt')
        ).length,
        1
    )
    assert.ok(
        harness.debugMessages.some(
            (message) =>
                message.includes('event=recall.agentic.search.results') &&
                message.includes('content-memory-1')
        )
    )
    assert.ok(
        harness.debugMessages.every(
            (message) =>
                !message.includes('我记得一段可靠的往事。') &&
                !message.includes('event=recall.agentic.turn.completed') &&
                !message.includes('event=tool.input') &&
                !message.includes('event=tool.output')
        )
    )
})

it('rejects stringified arrays and allows corrected search input', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('invalid-1', {
                searchTexts: '["记忆"]'
            }),
            createSearchCall('search-2'),
            new AIMessage('我记得修正查询后找到的内容。')
        ],
        search: async () => [createSearchResult('memory-2')]
    })

    const trace = await harness.run()
    const invalidOutput = String(
        toolMessages(harness.boundInvocations[1])[0]?.content
    )

    assert.ok(trace)
    assert.equal(trace.item.matchedMemories.length, 1)
    assert.match(
        invalidOutput,
        /Received tool input did not match expected schema/u
    )
    assert.match(invalidOutput, /Expected array, received string/u)
    assert.match(invalidOutput, /searchTexts/u)
    assert.equal(harness.searchInvocations.length, 1)
})

it('never normalizes repeated stringified array inputs', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('invalid-1', {
                searchTexts: '["记忆"]'
            }),
            createSearchCall('invalid-2', {
                searchTexts: '["计划"]'
            }),
            createSearchCall('invalid-3', {
                searchTexts: '["关系"]'
            }),
            new AIMessage('<NO_MEMORY>')
        ]
    })

    const trace = await harness.run()
    const failedOutput = String(
        toolMessages(harness.boundInvocations[3]).at(-1)?.content
    )

    assert.equal(trace, null)
    assert.match(
        failedOutput,
        /Received tool input did not match expected schema/u
    )
    assert.match(failedOutput, /Expected array, received string/u)
    assert.equal(harness.searchInvocations.length, 0)
})

it('handles every tool call in a multi-call model response', async () => {
    let releaseFirstSearch!: () => void
    const firstSearchCanComplete = new Promise<void>((resolve) => {
        releaseFirstSearch = resolve
    })
    const harness = createHarness({
        responses: [
            createMultipleSearchCalls([
                { id: 'search-1', input: validSearchInput('记忆') },
                { id: 'search-2', input: validSearchInput('计划') }
            ]),
            new AIMessage('我记得两段相关内容。')
        ],
        search: async (invocation) => {
            if (invocation.input.searchTexts[0] === '记忆') {
                await firstSearchCanComplete
            } else {
                releaseFirstSearch()
            }
            return [
                createSearchResult(
                    invocation.input.searchTexts[0] === '记忆'
                        ? 'memory-1'
                        : 'memory-2'
                )
            ]
        }
    })

    const trace = await harness.run()
    const returnedToolMessages = toolMessages(harness.boundInvocations[1])

    assert.ok(trace)
    assert.equal(harness.searchInvocations.length, 2)
    assert.equal(returnedToolMessages.length, 2)
    assert.deepEqual(
        returnedToolMessages.map((message) => message.tool_call_id),
        ['search-1', 'search-2']
    )
    assert.equal(trace.item.matchedMemories.length, 2)
    assert.deepEqual(
        trace.item.matchedMemories.map((memory) => memory.content),
        ['content-memory-1', 'content-memory-2']
    )
})

it('recovers from malformed raw tool arguments through parser observation', async () => {
    const malformedSearchToolCall: OpenAIToolCall = {
        id: 'malformed-1',
        type: 'function',
        function: {
            name: livingMemorySearchToolName,
            arguments: '{'
        }
    }
    const harness = createHarness({
        responses: [
            new AIMessage({
                content: '',
                additional_kwargs: {
                    tool_calls: [malformedSearchToolCall]
                }
            }),
            createSearchCall('search-2'),
            new AIMessage('我记得恢复后的搜索结果。')
        ],
        search: async () => [createSearchResult('memory-3')]
    })

    const trace = await harness.run()

    assert.ok(trace)
    assert.equal(trace.item.matchedMemories.length, 1)
    assert.equal(harness.boundInvocations.length, 3)
    assert.equal(harness.searchInvocations.length, 1)
})

it('allows the model to recover from an unavailable tool call', async () => {
    const harness = createHarness({
        responses: [
            new AIMessage({
                content: '',
                tool_calls: [
                    {
                        name: 'unknown_memory_tool',
                        args: {},
                        id: 'unknown-1',
                        type: 'tool_call'
                    }
                ]
            }),
            createSearchCall('search-2'),
            new AIMessage('我记得纠正工具名称后的结果。')
        ],
        search: async () => [createSearchResult('memory-4')]
    })

    const trace = await harness.run()
    const unavailableOutput = String(
        toolMessages(harness.boundInvocations[1])[0]?.content
    )

    assert.match(unavailableOutput, /is not valid/u)
    assert.ok(trace)
    assert.equal(trace.item.matchedMemories.length, 1)
})

it('propagates hard search service failures to the coordinator boundary', async () => {
    const harness = createHarness({
        responses: [createSearchCall('search-1')],
        search: async () => {
            throw new Error('database unavailable')
        }
    })

    await assert.rejects(harness.run(), /database unavailable/u)
})

it('propagates hard model invocation failures', async () => {
    const harness = createHarness({
        responses: [new Error('model unavailable')]
    })

    await assert.rejects(harness.run(), /model unavailable/u)
    assert.equal(harness.searchInvocations.length, 0)
})

it('fails after six invalid tool calls without updating a recall result', async () => {
    const harness = createHarness({
        responses: Array.from({ length: 6 }, (_, index) =>
            createSearchCall(`invalid-${index + 1}`, {
                searchTexts: '["记忆"]'
            })
        )
    })

    await assert.rejects(
        harness.run(),
        /did not finish within 6 model calls/u
    )
    assert.equal(harness.boundInvocations.length, 6)
    assert.equal(harness.searchInvocations.length, 0)
})

it('accepts a normal final response on the sixth model call', async () => {
    const harness = createHarness({
        responses: [
            ...['一', '二', '三', '四', '五'].map((text, index) =>
                createSearchCall(
                    `search-${index + 1}`,
                    validSearchInput(`查询${text}`)
                )
            ),
            new AIMessage('我记得在多次查询中确认的事实。')
        ],
        search: async (invocation) => [
            createSearchResult(`memory-${invocation.input.searchTexts[0]}`)
        ]
    })

    const trace = await harness.run()

    assert.ok(trace)
    assert.equal(
        trace.item.finalText,
        '我记得在多次查询中确认的事实。'
    )
    assert.equal(trace.item.matchedMemories.length, 5)
    assert.equal(harness.boundInvocations.length, 6)
    assert.equal(
        harness.debugMessages.filter((message) =>
            message.includes('event=model.prompt')
        ).length,
        1
    )
    assert.ok(
        harness.debugMessages.every(
            (message) => !message.includes('我记得在多次查询中确认的事实。')
        )
    )
})

it('returns no result when the final text has no matched memories', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1'),
            new AIMessage('没有搜索依据的记忆文本')
        ],
        search: async () => []
    })

    const trace = await harness.run()

    assert.equal(trace, null)
    assert.equal(
        String(toolMessages(harness.boundInvocations[1])[0]?.content),
        '没有找到相关记忆。'
    )
})

it('allows a second successful search with different arguments', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1', validSearchInput('记忆')),
            createSearchCall('search-2', validSearchInput('计划')),
            new AIMessage('我记得不同查询共同确认的内容。')
        ],
        search: async (invocation) => [
            createSearchResult(
                invocation.input.searchTexts[0] === '记忆'
                    ? 'memory-1'
                    : 'memory-2'
            )
        ]
    })

    const trace = await harness.run()

    assert.ok(trace)
    assert.equal(harness.searchInvocations.length, 2)
    assert.equal(trace.item.matchedMemories.length, 2)
    assert.deepEqual(trace.item.toolCallSummary.searchTexts, ['记忆', '计划'])
})

it('builds trace data from raw search output before AgentRunner guidance', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1', validSearchInput('记忆')),
            createSearchCall('search-2', validSearchInput('计划')),
            new AIMessage('我记得两次查询返回的同一事实。')
        ],
        search: async () => [createSearchResult('memory-1')]
    })

    const trace = await harness.run()
    const secondObservation = String(
        toolMessages(harness.boundInvocations[2]).at(-1)?.content
    )

    assert.match(secondObservation, /Tool loop guidance/u)
    assert.ok(trace)
    assert.equal(trace.item.matchedMemories.length, 1)
    assert.equal(trace.item.matchedMemories[0]?.content, 'content-memory-1')
})
