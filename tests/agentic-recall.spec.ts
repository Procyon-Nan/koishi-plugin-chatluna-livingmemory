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
import type { z } from 'zod'
import { LivingMemoryLogger } from '../src/service/logging/logger'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    LivingMemorySearchInput,
    LivingMemorySearchResult,
    MemoryScope
} from '../src/contracts/memory'
import {
    memorySearchTool,
    memoryUpdateSnapshotTool,
    memoryPassTool
} from '../src/service/prompts/memory_tools'
import { LivingMemoryAgenticRecallExecutor } from '../src/service/workflows/recall/agentic_recall'
import type { LivingMemorySearchEngine } from '../src/service/workflows/recall/memory_search_engine'
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
    enableConversationIsolation: false,
    subModel: 'test/model',
    snapshotMaxLines: 5,
    embeddingModel: 'test-embedding',
    debug: false,
    memorySearchToolMaxResults: 30
} as const

const testScope: MemoryScope = {
    ...scope,
    userId: 'user-1',
    presetLabel: '助手<&'
}

const validSearchInput = (
    text: string
): z.infer<typeof memorySearchTool.schema> => ({
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
                name: memorySearchTool.name,
                args: input,
                id,
                type: 'tool_call'
            }
        ]
    })
}

const createSnapshotUpdate = (text: string) =>
    new AIMessage({
        content: '',
        tool_calls: [
            {
                name: memoryUpdateSnapshotTool.name,
                args: { operations: [{ type: 'append', text }] },
                id: 'update-snapshot',
                type: 'tool_call'
            }
        ]
    })

const createPassCall = () =>
    new AIMessage({
        content: '',
        tool_calls: [
            {
                name: memoryPassTool.name,
                args: {},
                id: 'pass',
                type: 'tool_call'
            }
        ]
    })

const createMultipleSearchCalls = (
    calls: { id: string; input: z.infer<typeof memorySearchTool.schema> }[]
) => {
    return new AIMessage({
        content: '',
        tool_calls: calls.map((call) => ({
            name: memorySearchTool.name,
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
    sourceLabel: null,
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
    } as unknown as LivingMemorySearchEngine
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
        run: () =>
            executor.run(testScope, currentMessage, [], [], async () => {})
    }
}

const toolMessages = (invocation: ModelInvocation | undefined) => {
    return invocation?.messages.filter(isToolMessage) ?? []
}

it('runs one search through AgentRunner and preserves preset-scoped trace data', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1'),
            createSnapshotUpdate('我记得一段可靠的往事。')
        ],
        search: async () => [createSearchResult('memory-1')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.finalText, '我记得一段可靠的往事。')
    assert.equal(snapshot.matchedMemories.length, 1)
    assert.equal(snapshot.matchedMemories[0]?.content, 'content-memory-1')
    assert.deepEqual(snapshot.toolCallSummary.searchTexts, ['记忆'])
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
        /你是助手&lt;&amp;/u
    )
    assert.doesNotMatch(
        String(harness.boundInvocations[0]?.messages[0]?.content),
        /你是preset-1/u
    )
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
})

it('rejects stringified arrays and allows corrected search input', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('invalid-1', {
                searchTexts: '["记忆"]'
            }),
            createSearchCall('search-2'),
            createSnapshotUpdate('我记得修正查询后找到的内容。')
        ],
        search: async () => [createSearchResult('memory-2')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.matchedMemories.length, 1)
    assert.equal(harness.searchInvocations.length, 1)
})

it('passes without updating after invalid search input', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('invalid-1', {
                searchTexts: '["记忆"]'
            }),
            createPassCall()
        ]
    })

    const snapshot = await harness.run()

    assert.equal(snapshot, null)
    assert.equal(harness.searchInvocations.length, 0)
})

it('rejects multiple tool calls and accepts corrected serial calls', async () => {
    const harness = createHarness({
        responses: [
            createMultipleSearchCalls([
                { id: 'search-1', input: validSearchInput('记忆') },
                { id: 'search-2', input: validSearchInput('计划') }
            ]),
            createSearchCall('search-3', validSearchInput('记忆')),
            createSearchCall('search-4', validSearchInput('计划')),
            createSnapshotUpdate('我记得两段相关内容。')
        ],
        search: async (invocation) => [
            createSearchResult(invocation.input.searchTexts[0])
        ]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(harness.boundInvocations.length, 4)
    assert.equal(harness.searchInvocations.length, 2)
    assert.match(
        String(toolMessages(harness.boundInvocations[1])[0]?.content),
        /每次只调用一个工具/u
    )
    assert.equal(snapshot.matchedMemories.length, 2)
    assert.deepEqual(
        snapshot.matchedMemories.map((memory) => memory.content),
        ['content-记忆', 'content-计划']
    )
})

it('recovers from malformed raw tool arguments through parser observation', async () => {
    const malformedSearchToolCall: OpenAIToolCall = {
        id: 'malformed-1',
        type: 'function',
        function: {
            name: memorySearchTool.name,
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
            createSnapshotUpdate('我记得恢复后的搜索结果。')
        ],
        search: async () => [createSearchResult('memory-3')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.matchedMemories.length, 1)
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
            createSnapshotUpdate('我记得纠正工具名称后的结果。')
        ],
        search: async () => [createSearchResult('memory-4')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.matchedMemories.length, 1)
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

it('fails after six invalid tool calls without updating a recall result', async () => {
    const harness = createHarness({
        responses: Array.from({ length: 6 }, (_, index) =>
            createSearchCall(`invalid-${index + 1}`, {
                searchTexts: '["记忆"]'
            })
        )
    })

    await assert.rejects(harness.run(), /did not finish within 6 model calls/u)
    assert.equal(harness.boundInvocations.length, 6)
    assert.equal(harness.searchInvocations.length, 0)
})

it('accepts a snapshot update on the sixth model call', async () => {
    const harness = createHarness({
        responses: [
            ...['一', '二', '三', '四', '五'].map((text, index) =>
                createSearchCall(
                    `search-${index + 1}`,
                    validSearchInput(`查询${text}`)
                )
            ),
            createSnapshotUpdate('我记得在多次查询中确认的事实。')
        ],
        search: async (invocation) => [
            createSearchResult(`memory-${invocation.input.searchTexts[0]}`)
        ]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(snapshot.finalText, '我记得在多次查询中确认的事实。')
    assert.equal(snapshot.matchedMemories.length, 5)
    assert.equal(harness.boundInvocations.length, 6)
    assert.deepEqual(snapshot.toolCallSummary.searchTexts, [
        '查询一',
        '查询二',
        '查询三',
        '查询四',
        '查询五'
    ])
})

it('passes after a search returns no memories', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1'),
            createPassCall()
        ],
        search: async () => []
    })

    const snapshot = await harness.run()

    assert.equal(snapshot, null)
    assert.equal(
        String(toolMessages(harness.boundInvocations[1])[0]?.content),
        '没有找到相关记忆。'
    )
})

it('deduplicates a memory returned by repeated searches', async () => {
    const harness = createHarness({
        responses: [
            createSearchCall('search-1', validSearchInput('记忆')),
            createSearchCall('search-2', validSearchInput('计划')),
            createSnapshotUpdate('我记得两次查询返回的同一事实。')
        ],
        search: async () => [createSearchResult('memory-1')]
    })

    const snapshot = await harness.run()

    assert.ok(snapshot)
    assert.equal(harness.searchInvocations.length, 2)
    assert.equal(snapshot.matchedMemories.length, 1)
    assert.equal(snapshot.matchedMemories[0]?.content, 'content-memory-1')
})
