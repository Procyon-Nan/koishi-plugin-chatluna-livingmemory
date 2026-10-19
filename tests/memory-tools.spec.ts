import assert from 'node:assert/strict'
import {
    ToolInputParsingException,
    type ToolRunnableConfig
} from '@langchain/core/tools'
import { createMemoryTool } from '../src/service/memory/tools'
import { LivingMemoryGetMessagesTool } from '../src/service/memory/tools/get_messages_tool'
import { memorySearchTool } from '../src/service/prompts/memory_tools'
import { LivingMemorySearchTool } from '../src/service/memory/tools/embedding_search_tool'
import type { LivingMemorySearchInput } from '../src/contracts/memory'
import type { LivingMemorySourceProvider } from '../src/contracts/workflows'
import type { LivingMemoryEmbeddingSearchEngine } from '../src/service/workflows/recall/embedding_search_engine'
import { resolveMainRunConversationId } from '../src/service/memory/helpers'
import {
    describeLivingMemoryToolScopeFailure,
    resolveToolMemoryPresetId,
    resolveToolMemoryScopeConfigurable,
    type LivingMemoryToolConfigurable
} from '../src/service/memory/tools/tool_runtime'

const mockEngine = {
    searchMemories: async () => []
} as unknown as LivingMemoryEmbeddingSearchEngine

const searchTool = createMemoryTool.search(mockEngine, true)

const createRecordingSearchProvider = () => {
    const presetIds: string[] = []
    const provider = {
        searchMemories: async (presetId: string) => {
            presetIds.push(presetId)
            return []
        }
    } as unknown as LivingMemoryEmbeddingSearchEngine
    return { presetIds, provider }
}

const toolConfig = (
    configurable: LivingMemoryToolConfigurable
): ToolRunnableConfig<LivingMemoryToolConfigurable> => ({ configurable })

it('rejects stringified arrays on the model-facing search tool', async () => {
    await assert.rejects(
        searchTool.invoke({
            searchTexts: '["关系", "称呼"]'
        } as never),
        ToolInputParsingException
    )
})

it('always searches active memories with the shared tool schema', async () => {
    const inputs: LivingMemorySearchInput[] = []
    const provider = {
        searchMemories: async (
            _presetId: string,
            input: LivingMemorySearchInput
        ) => {
            inputs.push(input)
            return []
        }
    } as unknown as LivingMemoryEmbeddingSearchEngine

    const mainTool = createMemoryTool.search(provider, true)
    assert.equal(mainTool.schema, memorySearchTool.schema)
    assert.equal(searchTool.schema, memorySearchTool.schema)
    assert.deepEqual(Object.keys(mainTool.schema.shape), [
        'searchTexts',
        'searchKeywords'
    ])

    await mainTool.invoke(
        { searchTexts: ['我们聊过的事情'], memoryStatus: 'archived' } as never,
        toolConfig({
            preset: 'default',
            agentContext: { kind: 'main', source: 'chatluna' }
        })
    )
    assert.equal(inputs[0].memoryStatus, 'active')
    await mainTool.runSearch(
        { searchTexts: ['我们聊过的事情'], memoryStatus: 'all' } as never,
        toolConfig({ preset: 'default' })
    )
    assert.equal(inputs[1].memoryStatus, 'active')
})

it('renders source messages as the original transcript of one memory', async () => {
    const service: LivingMemorySourceProvider = {
        getMemorySourceMessages: async (_presetId: string, memoryId: string) =>
            memoryId === 'memory-1'
                ? {
                      id: 'memory-1',
                      sourceLabel: '来源于「摸鱼群」（群聊 ID：10001）的群聊',
                      sourceOrigins: [
                          {
                              messages: [
                                  {
                                      role: 'user',
                                      content: '展览你去看了吗',
                                      transcriptLines: [
                                          '[2026-07-01 12:00] Alice说：展览你去看了吗'
                                      ]
                                  }
                              ]
                          },
                          {
                              messages: [
                                  {
                                      role: 'assistant',
                                      content: '下周再一起去',
                                      transcriptLines: [
                                          '[2026-07-03 15:00] Alice说：下周再一起去'
                                      ]
                                  }
                              ]
                          }
                      ]
                  }
                : null
    }
    const config = toolConfig({
        preset: 'default',
        agentContext: { kind: 'main', source: 'chatluna' }
    })

    assert.equal(
        await new LivingMemoryGetMessagesTool(service).invoke(
            { memoryId: 'memory-1' },
            config
        ),
        [
            'id=memory-1',
            'source=来源于「摸鱼群」（群聊 ID：10001）的群聊',
            '来源对话 1/2：',
            '[2026-07-01 12:00] Alice说：展览你去看了吗',
            '',
            '来源对话 2/2：',
            '[2026-07-03 15:00] Alice说：下周再一起去'
        ].join('\n')
    )
    await assert.rejects(
        new LivingMemoryGetMessagesTool(service).invoke(
            { memoryId: 'missing' },
            config
        ),
        /不存在 ID 为 missing 的记忆，请重新查明记忆 ID 后再调用。/
    )
})

it('resolves the raw preset for ChatLuna tool calls', () => {
    assert.deepEqual(
        resolveToolMemoryPresetId({
            preset: 'default',
            agentContext: { kind: 'main', source: 'chatluna' }
        }),
        { ok: true, presetId: 'default' }
    )
})

it('appends the Character suffix to the preset for Character tool calls', () => {
    assert.deepEqual(
        resolveToolMemoryPresetId({
            preset: '史尔特里',
            agentContext: { kind: 'main', source: 'character' }
        }),
        { ok: true, presetId: '史尔特里（Character）' }
    )
})

it('rejects tool calls without a preset', () => {
    assert.deepEqual(resolveToolMemoryPresetId({}), {
        ok: false,
        reason: 'missing-preset'
    })
    assert.match(
        describeLivingMemoryToolScopeFailure('missing-preset'),
        /Missing preset/u
    )
})

it('rebuilds the ChatLuna scope from the agent run context', () => {
    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: 'default',
            agentContext: { kind: 'main', conversationId: 'conversation-1' },
            session: {
                platform: 'onebot',
                userId: 'user-1',
                channelId: 'channel-1',
                guildId: 'guild-1',
                isDirect: false
            }
        }),
        {
            ok: true,
            scope: {
                conversationId: 'conversation-1',
                presetId: 'default',
                userId: 'user-1',
                channelId: 'channel-1',
                guildId: 'guild-1',
                isDirect: false,
                speakerId: 'user-1',
                platform: 'onebot'
            }
        }
    )
})

it('rebuilds the Character group and private scope from the session', () => {
    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: '史尔特里',
            agentContext: { kind: 'main', source: 'character' },
            session: {
                platform: 'onebot',
                userId: 'user-1',
                guildId: 'guild-1',
                isDirect: false
            }
        }),
        {
            ok: true,
            scope: {
                conversationId: 'group:guild-1',
                presetId: '史尔特里（Character）',
                userId: 'user-1',
                channelId: undefined,
                guildId: 'guild-1',
                isDirect: false,
                speakerId: 'user-1',
                platform: 'onebot'
            }
        }
    )

    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: '史尔特里',
            agentContext: { kind: 'main', source: 'character' },
            session: {
                platform: 'onebot',
                userId: 'user-1',
                isDirect: true
            }
        }),
        {
            ok: true,
            scope: {
                conversationId: 'private:user-1',
                presetId: '史尔特里（Character）',
                userId: 'user-1',
                channelId: undefined,
                guildId: undefined,
                isDirect: true,
                speakerId: 'user-1',
                platform: 'onebot'
            }
        }
    )
})

it('rejects Character tool calls without a session or session key', () => {
    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: '史尔特里',
            agentContext: { kind: 'main', source: 'character' }
        }),
        { ok: false, reason: 'missing-session' }
    )

    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: '史尔特里',
            agentContext: { kind: 'main', source: 'character' },
            session: { userId: 'user-1', isDirect: false }
        }),
        { ok: false, reason: 'missing-session-key' }
    )
})

it('rejects ChatLuna tool calls without a conversation id', () => {
    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({ preset: 'default' }),
        {
            ok: false,
            reason: 'missing-conversation-id'
        }
    )
    // ChatLuna 1.4.0-alpha.44 起扁平 conversationId 已移除，仅认 agentContext。
    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: 'default',
            conversationId: 'conversation-1'
        } as LivingMemoryToolConfigurable & { conversationId: string }),
        { ok: false, reason: 'missing-conversation-id' }
    )
    assert.match(
        describeLivingMemoryToolScopeFailure('missing-conversation-id'),
        /Missing conversationId/u
    )
})

it('rejects sub-agent tool calls with a dedicated failure', () => {
    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: 'default',
            agentContext: {
                kind: 'subagent',
                conversationId: 'subagent:task-1'
            },
            session: { userId: 'user-1', isDirect: true }
        }),
        { ok: false, reason: 'subagent-tool-call' }
    )
    assert.match(
        describeLivingMemoryToolScopeFailure('subagent-tool-call'),
        /Sub-agent tool calls/u
    )
})

it('resolves the main run conversation id only for non-subagent run contexts', () => {
    assert.equal(
        resolveMainRunConversationId({
            kind: 'main',
            conversationId: 'conversation-1'
        }),
        'conversation-1'
    )
    assert.equal(
        resolveMainRunConversationId({
            kind: 'subagent',
            conversationId: 'subagent:task-1'
        }),
        undefined
    )
    assert.equal(resolveMainRunConversationId(null), undefined)
    assert.equal(resolveMainRunConversationId('main'), undefined)
    assert.equal(
        resolveMainRunConversationId({ kind: 'main', conversationId: '  ' }),
        undefined
    )
})

it('queries the suffixed preset from the search tool in Character sessions', async () => {
    const chatluna = createRecordingSearchProvider()
    const character = createRecordingSearchProvider()

    await new LivingMemorySearchTool(chatluna.provider, true).invoke(
        { searchTexts: ['我们一起聊过的事情'] },
        toolConfig({
            preset: 'default',
            agentContext: {
                kind: 'main',
                source: 'chatluna',
                conversationId: 'conversation-1'
            },
            session: { userId: 'user-1', isDirect: true }
        })
    )
    await new LivingMemorySearchTool(character.provider, true).invoke(
        { searchTexts: ['我们一起聊过的事情'] },
        toolConfig({
            preset: '史尔特里',
            agentContext: { kind: 'main', source: 'character' },
            session: {
                userId: 'user-1',
                guildId: 'guild-1',
                isDirect: false
            }
        })
    )

    assert.deepEqual(chatluna.presetIds, ['default'])
    assert.deepEqual(character.presetIds, ['史尔特里（Character）'])
})

it('renders search observations with memory ids and reports empty results', async () => {
    const provider = {
        searchMemories: async () => [
            {
                id: 'memory-1',
                type: 'fact',
                content: '我们在上周一起去看了展览。',
                keywords: ['展览'],
                summary: '看展览',
                sentiment: '愉快',
                importance: 0.8,
                sourceLabel: '来源于「摸鱼群」（群聊 ID：10001）的群聊',
                createdAt: new Date('2026-07-01T00:00:00.000Z'),
                updatedAt: new Date('2026-07-02T00:00:00.000Z')
            }
        ]
    } as unknown as LivingMemoryEmbeddingSearchEngine
    const config = toolConfig({
        preset: 'default',
        agentContext: { kind: 'main', source: 'chatluna' }
    })

    assert.equal(
        await new LivingMemorySearchTool(provider, true).invoke(
            { searchTexts: ['我们一起聊过的事情'] },
            config
        ),
        [
            'id=memory-1',
            'type=fact',
            'updatedAt=2026-07-02T00:00:00.000Z',
            'sentiment=愉快',
            'source=来源于「摸鱼群」（群聊 ID：10001）的群聊',
            'content:',
            '我们在上周一起去看了展览。'
        ].join('\n')
    )
    assert.equal(
        await searchTool.invoke({ searchTexts: ['没有记录的事情'] }, config),
        '没有找到相关记忆。'
    )
})
