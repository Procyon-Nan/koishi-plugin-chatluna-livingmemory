import assert from 'node:assert/strict'
import { ToolInputParsingException } from '@langchain/core/tools'
import type { MemoryMutationInput } from '../src/contracts/memory'
import type { MemoryScope } from '../src/contracts/memory'
import type { LivingMemoryCreationProvider } from '../src/contracts/workflows'
import {
    livingMemoryCreateMemoryToolDescription,
    livingMemoryCreateMemoryToolName
} from '../src/service/memory/tools/create_contract'
import { LivingMemoryCreateMemoryTool } from '../src/service/memory/tools/create_memory_tool'
import {
    LivingMemoryFactsCommittedError,
    LivingMemoryVectorIndexError
} from '../src/service/vector_index/errors'

const chatlunaConfigurable = {
    preset: 'default',
    agentContext: { kind: 'main', conversationId: 'conversation-1' },
    source: 'chatluna',
    session: { userId: 'user-1', channelId: 'c-1', isDirect: true }
}

const subagentConfigurable = {
    preset: 'default',
    agentContext: { kind: 'subagent', conversationId: 'subagent:task-1' },
    source: 'chatluna',
    session: { userId: 'user-1', channelId: 'c-1', isDirect: true }
}

const characterConfigurable = {
    preset: '史尔特里',
    source: 'character',
    session: { userId: 'user-1', guildId: 'guild-1', isDirect: false }
}

const sampleMemory = {
    type: 'fact',
    content: '张三在2026-08-15说他喜欢爬山，我表示下次一起',
    summary: '张三喜欢爬山，我约好下次同去',
    keywords: ['张三', '爬山', '约定'],
    sentiment: '愉快',
    importance: 0.7
}

const createRecordingProvider = (
    failureFor?: (input: MemoryMutationInput) => Error
) => {
    const calls: { scope: MemoryScope; input: MemoryMutationInput }[] = []
    let sequence = 0
    const provider: LivingMemoryCreationProvider = {
        createMemory: async (scope, input) => {
            const error = failureFor?.(input)
            if (error != null) {
                throw error
            }
            calls.push({ scope, input })
            sequence += 1
            return {
                id: `memory-${sequence}`,
                presetId: scope.presetId,
                type: input.type,
                status: 'active',
                content: input.content,
                keywords: input.keywords ?? [],
                summary: input.summary ?? null,
                sentiment: input.sentiment ?? null,
                importance: input.importance ?? null,
                sourceConversationId: scope.conversationId,
                sourceOrigins: [],
                isConsolidated: false,
                createdAt: new Date(),
                updatedAt: new Date()
            }
        }
    }
    return { calls, provider }
}

const rejectsToolInvocation = async (
    promise: Promise<unknown>,
    pattern: RegExp
) => {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof ToolInputParsingException)
        assert.match(error.message, pattern)
        return true
    })
}

it('exposes the extraction-aligned schema directly to the model-facing tool', async () => {
    const { provider } = createRecordingProvider()
    const tool = new LivingMemoryCreateMemoryTool(provider, 10)

    assert.equal(tool.name, livingMemoryCreateMemoryToolName)
    assert.match(livingMemoryCreateMemoryToolDescription, /memories：是必填项/u)
    assert.match(
        livingMemoryCreateMemoryToolDescription,
        /禁止把数组编码成 JSON 字符串|错误 \{"memories":"\[\.\.\.\]"\}/u
    )
    // D10：单次写入数量不做提示词指导；字段规范中 keywords 的
    // "最多 12 个" 属于字段统一要求，不在禁止范围。
    assert.doesNotMatch(
        livingMemoryCreateMemoryToolDescription,
        /最多 \d+ 条|一次最多|单次最多|条数上限/u
    )
    assert.deepEqual(Object.keys(tool.schema.shape), ['memories'])

    await rejectsToolInvocation(
        tool.invoke({ memories: '[]' } as never, {
            configurable: chatlunaConfigurable
        }),
        /Expected array, received string/u
    )
})

it('rejects batches exceeding the configured maximum', async () => {
    const { provider } = createRecordingProvider()
    const tool = new LivingMemoryCreateMemoryTool(provider, 2)

    await rejectsToolInvocation(
        tool.invoke(
            { memories: [sampleMemory, sampleMemory, sampleMemory] },
            { configurable: chatlunaConfigurable }
        ),
        /at most 2/u
    )
})

it('creates memories with the resolved ChatLuna scope and returns ids', async () => {
    const { calls, provider } = createRecordingProvider()
    const tool = new LivingMemoryCreateMemoryTool(provider, 10)

    const output = JSON.parse(
        (await tool.invoke(
            { memories: [sampleMemory] },
            { configurable: chatlunaConfigurable }
        )) as string
    ) as { createdMemories: { id: string; type: string }[]; warnings: string[] }

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.scope.presetId, 'default')
    assert.equal(calls[0]?.scope.conversationId, 'conversation-1')
    assert.equal(calls[0]?.input.content, sampleMemory.content)
    assert.deepEqual(output.createdMemories, [{ id: 'memory-1', type: 'fact' }])
    assert.deepEqual(output.warnings, [])
})

it('creates memories with the suffixed preset and group session key in Character sessions', async () => {
    const { calls, provider } = createRecordingProvider()
    const tool = new LivingMemoryCreateMemoryTool(provider, 10)

    await tool.invoke(
        { memories: [sampleMemory] },
        {
            configurable: characterConfigurable
        }
    )

    assert.equal(calls[0]?.scope.presetId, '史尔特里（Character）')
    assert.equal(calls[0]?.scope.conversationId, 'group:guild-1')
})

it('reports committed memories as saved with a warning when index synchronization fails', async () => {
    let invoked = 0
    const { calls, provider } = createRecordingProvider()
    const failingProvider: LivingMemoryCreationProvider = {
        createMemory: async (scope, input) => {
            invoked += 1
            if (invoked === 2) {
                throw new LivingMemoryFactsCommittedError(
                    'injected index failure',
                    {}
                )
            }
            return provider.createMemory(scope, input)
        }
    }
    const tool = new LivingMemoryCreateMemoryTool(failingProvider, 10)

    const output = JSON.parse(
        (await tool.invoke(
            { memories: [sampleMemory, sampleMemory] },
            { configurable: chatlunaConfigurable }
        )) as string
    ) as { createdMemories: unknown[]; warnings: string[] }

    assert.equal(invoked, 2)
    assert.equal(calls.length, 1)
    assert.equal(output.createdMemories.length, 1)
    assert.equal(output.warnings.length, 1)
    assert.match(output.warnings[0] as string, /已调度后台自动对账/u)
})

it('propagates not-ready failures before any memory is committed', async () => {
    const notReady = new LivingMemoryVectorIndexError(
        'not-ready',
        'building',
        'vector index is not ready'
    )
    const failingProvider: LivingMemoryCreationProvider = {
        createMemory: async () => {
            throw notReady
        }
    }
    const tool = new LivingMemoryCreateMemoryTool(failingProvider, 10)

    await assert.rejects(
        tool.invoke(
            { memories: [sampleMemory] },
            {
                configurable: chatlunaConfigurable
            }
        ),
        (error: unknown) => {
            assert.ok(error instanceof LivingMemoryVectorIndexError)
            assert.equal(error, notReady)
            return true
        }
    )
})

it('rejects tool calls without a resolvable scope', async () => {
    const { provider } = createRecordingProvider()
    const tool = new LivingMemoryCreateMemoryTool(provider, 10)

    await assert.rejects(
        tool.invoke({ memories: [sampleMemory] }, { configurable: {} }),
        /Missing preset/u
    )
})

it('rejects tool calls from sub-agent runs', async () => {
    const { calls, provider } = createRecordingProvider()
    const tool = new LivingMemoryCreateMemoryTool(provider, 10)

    await assert.rejects(
        tool.invoke(
            { memories: [sampleMemory] },
            { configurable: subagentConfigurable }
        ),
        /Sub-agent tool calls/u
    )
    assert.equal(calls.length, 0)
})
