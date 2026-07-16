import assert from 'node:assert/strict'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables'
import type { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    MemoryScope
} from '../src/contracts/memory'
import { livingMemorySearchToolName } from '../src/service/memory/tools/search_contract'
import { LivingMemoryAgenticRecallExecutor } from '../src/service/workflows/recall/agentic_recall'
import { currentMessage, scope } from './workflow-test-utils'

interface ModelInvocation {
    messages: BaseMessage[]
    config?: RunnableConfig
}

interface SearchInvocation {
    presetId: string
    input: LivingMemorySearchInput & { maxCandidates: number }
}

interface AgenticRecallHarnessOptions {
    responses: (BaseMessage | Error)[]
    finalResponse?: BaseMessage | Error
    search?: (
        presetId: string,
        input: SearchInvocation['input']
    ) => Promise<LivingMemorySearchResult[]>
}

const config = {
    agenticRecallModel: 'test/model',
    debug: false,
    memorySearchToolMaxResults: 30,
    recallHistoryWindowRounds: 3
} as const

const testScope: MemoryScope = {
    ...scope,
    userId: 'user-1'
}

const validSearchInput = (text: string): LivingMemorySearchInput => ({
    broadSearchTexts: [text],
    memoryTypes: ['all']
})

const createSearchCall = (
    id: string,
    input: Record<string, unknown> = validSearchInput('记忆')
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
    calls: { id: string; input: LivingMemorySearchInput }[]
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

const createSearchResult = (
    id: string,
    broadSearchText = '记忆'
): LivingMemorySearchResult => ({
    id,
    type: 'fact',
    content: `content-${id}`,
    keywords: ['记忆'],
    summary: `summary-${id}`,
    importance: 0.8,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    matchedBroadSearchTexts: [broadSearchText],
    matchedSpecificSearchTexts: []
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
    const directInvocations: ModelInvocation[] = []
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
        invoke: async (
            messages: BaseMessage[],
            runConfig?: RunnableConfig
        ) => {
            directInvocations.push({ messages, config: runConfig })
            return takeResponse(options.finalResponse)
        }
    } as unknown as ChatLunaChatModel
    const livingMemory = {
        searchMemories: async (
            presetId: string,
            input: SearchInvocation['input']
        ) => {
            searchInvocations.push({ presetId, input })
            return await (options.search?.(presetId, input) ?? [])
        }
    }
    const context = {
        chatluna: {
            createChatModel: async () => ({ value: model })
        },
        get: () => livingMemory,
        logger: () => ({ info: () => {}, warn: () => {} })
    } as unknown as Context
    const executor = new LivingMemoryAgenticRecallExecutor(
        context,
        config,
        () => {}
    )

    return {
        boundInvocations,
        directInvocations,
        searchInvocations,
        run: () => executor.run(testScope, currentMessage, [])
    }
}

const toolMessages = (invocation: ModelInvocation | undefined) => {
    return (
        invocation?.messages.filter((message) => message.getType() === 'tool') ??
        []
    )
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

    assert.equal(trace.finalOutput, '我记得一段可靠的往事。')
    assert.equal(trace.item.matchedMemories.length, 1)
    assert.equal(trace.item.matchedMemories[0]?.content, 'content-memory-1')
    assert.deepEqual(trace.item.toolCallSummary.broadSearchTexts, ['记忆'])
    assert.equal(harness.searchInvocations[0]?.presetId, scope.presetId)
    assert.equal(harness.boundInvocations.length, 2)
    assert.equal(harness.directInvocations.length, 0)
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
        String(harness.boundInvocations[0]?.messages[1]?.content),
        /<agentic_recall_input>/u
    )
    assert.match(trace.prompt, /^\[system\]/u)
    assert.match(trace.prompt, /\n\[human\]\n/u)
    assert.match(String(toolMessages(harness.boundInvocations[1])[0]?.content), /memory-1/u)
})

it('rejects stringified arrays and allows corrected search input', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('invalid-1', {
                broadSearchTexts: '["记忆"]',
                specificSearchTexts: '["具体记忆内容"]',
                memoryTypes: '["all"]'
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

    assert.equal(trace.item.matchedMemories.length, 1)
    assert.match(
        invalidOutput,
        /Received tool input did not match expected schema/u
    )
    assert.match(invalidOutput, /Expected array, received string/u)
    assert.match(invalidOutput, /broadSearchTexts/u)
    assert.match(invalidOutput, /specificSearchTexts/u)
    assert.match(invalidOutput, /memoryTypes/u)
    assert.equal(harness.searchInvocations.length, 1)
})

it('never normalizes repeated stringified array inputs', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('invalid-1', {
                broadSearchTexts: '["记忆"]',
                memoryTypes: '["all"]'
            }),
            createSearchCall('invalid-2', {
                broadSearchTexts: '["计划"]',
                memoryTypes: '["all"]'
            }),
            createSearchCall('invalid-3', {
                broadSearchTexts: '["关系"]',
                memoryTypes: '["all"]'
            }),
            new AIMessage('<NO_MEMORY>')
        ]
    })

    const trace = await harness.run()
    const failedOutput = String(
        toolMessages(harness.boundInvocations[3]).at(-1)?.content
    )

    assert.equal(trace.finalOutput, '<NO_MEMORY>')
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
        search: async (_presetId, input) => {
            if (input.broadSearchTexts[0] === '记忆') {
                await firstSearchCanComplete
            } else {
                releaseFirstSearch()
            }
            return [
                createSearchResult(
                    input.broadSearchTexts[0] === '记忆'
                        ? 'memory-1'
                        : 'memory-2',
                    input.broadSearchTexts[0]
                )
            ]
        }
    })

    const trace = await harness.run()
    const returnedToolMessages = toolMessages(harness.boundInvocations[1])

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
    const harness = createHarness({
        responses: [
            new AIMessage({
                content: '',
                additional_kwargs: {
                    tool_calls: [
                        {
                            id: 'malformed-1',
                            type: 'function',
                            function: {
                                name: livingMemorySearchToolName,
                                arguments: '{'
                            }
                        }
                    ]
                }
            }),
            createSearchCall('search-2'),
            new AIMessage('我记得恢复后的搜索结果。')
        ],
        search: async () => [createSearchResult('memory-3')]
    })

    const trace = await harness.run()

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
    assert.equal(harness.directInvocations.length, 0)
})

it('propagates hard model invocation failures', async () => {
    const harness = createHarness({
        responses: [new Error('model unavailable')]
    })

    await assert.rejects(harness.run(), /model unavailable/u)
    assert.equal(harness.searchInvocations.length, 0)
})

it('reserves the sixth model call for tool-free finalization and never calls a seventh time', async () => {
    const harness = createHarness({
        responses: ['一', '二', '三', '四', '五'].map((text, index) =>
            createSearchCall(
                `search-${index + 1}`,
                validSearchInput(`查询${text}`)
            )
        ),
        finalResponse: new AIMessage('没有真实命中的记忆文本'),
        search: async () => []
    })

    const trace = await harness.run()

    assert.equal(trace.finalOutput, '<NO_MEMORY>')
    assert.equal(trace.item.finalText, '')
    assert.equal(harness.boundInvocations.length, 5)
    assert.equal(harness.directInvocations.length, 1)
    assert.deepEqual(harness.directInvocations[0]?.config?.['tools'], [])
    assert.equal(harness.searchInvocations.length, 5)
    const finalMessages = harness.directInvocations[0]?.messages ?? []
    assert.deepEqual(
        finalMessages.slice(0, 2).map((message) => message.getType()),
        ['system', 'human']
    )
    assert.match(String(finalMessages[0]?.content), /<role>/u)
    assert.match(String(finalMessages[1]?.content), /<agentic_recall_input>/u)
    assert.equal(finalMessages.at(-1)?.getType(), 'human')
    assert.match(String(finalMessages.at(-1)?.content), /<finalization>/u)
})

it('accepts a valid sixth-call finalization when prior searches matched memory', async () => {
    const harness = createHarness({
        responses: ['一', '二', '三', '四', '五'].map((text, index) =>
            createSearchCall(
                `search-${index + 1}`,
                validSearchInput(`查询${text}`)
            )
        ),
        finalResponse: new AIMessage('我记得在多次查询中确认的事实。'),
        search: async (_presetId, input) => [
            createSearchResult(`memory-${input.broadSearchTexts[0]}`)
        ]
    })

    const trace = await harness.run()

    assert.equal(trace.finalOutput, '我记得在多次查询中确认的事实。')
    assert.equal(trace.item.matchedMemories.length, 5)
    assert.equal(harness.boundInvocations.length, 5)
    assert.equal(harness.directInvocations.length, 1)
})

it('normalizes a sixth-call tool request to <NO_MEMORY>', async () => {
    const harness = createHarness({
        responses: ['一', '二', '三', '四', '五'].map((text, index) =>
            createSearchCall(
                `search-${index + 1}`,
                validSearchInput(`查询${text}`)
            )
        ),
        finalResponse: createSearchCall('forbidden-final-search'),
        search: async () => [createSearchResult('memory-1')]
    })

    const trace = await harness.run()

    assert.equal(trace.finalOutput, '<NO_MEMORY>')
    assert.equal(trace.item.finalText, '')
    assert.equal(harness.boundInvocations.length, 5)
    assert.equal(harness.directInvocations.length, 1)
})

it('rejects an ordinary final memory text without matched memories', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1'),
            new AIMessage('没有搜索依据的记忆文本')
        ],
        search: async () => []
    })

    await assert.rejects(
        harness.run(),
        /produced memory text without matched memories/u
    )
})

it('allows a second successful search with different arguments', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1', validSearchInput('记忆')),
            createSearchCall('search-2', validSearchInput('计划')),
            new AIMessage('我记得不同查询共同确认的内容。')
        ],
        search: async (_presetId, input) => [
            createSearchResult(
                input.broadSearchTexts[0] === '记忆'
                    ? 'memory-1'
                    : 'memory-2',
                input.broadSearchTexts[0]
            )
        ]
    })

    const trace = await harness.run()

    assert.equal(harness.searchInvocations.length, 2)
    assert.equal(trace.item.matchedMemories.length, 2)
    assert.deepEqual(trace.item.toolCallSummary.broadSearchTexts, [
        '记忆',
        '计划'
    ])
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
    assert.equal(trace.item.matchedMemories.length, 1)
    assert.equal(trace.item.matchedMemories[0]?.content, 'content-memory-1')
})
