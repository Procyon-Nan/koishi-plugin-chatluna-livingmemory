import assert from 'node:assert/strict'
import {
    ToolInputParsingException,
    type ToolRunnableConfig
} from '@langchain/core/tools'
import type { Context } from 'koishi'
import {
    LivingMemoryGetMessagesTool,
    livingMemoryGetMessagesToolDescription
} from '../src/service/memory/tools/get_messages_tool'
import {
    livingMemorySearchInputSchema,
    livingMemoryGetMessagesInputSchema
} from '../src/service/memory/tools/search_contract'
import {
    livingMemorySearchToolDescription,
    LivingMemorySearchTool
} from '../src/service/memory/tools/embedding_search_tool'
import type { LivingMemoryEmbeddingSearchEngine } from '../src/service/workflows/recall/embedding_search_engine'
import { resolveMainRunConversationId } from '../src/service/memory/helpers'
import {
    describeLivingMemoryToolScopeFailure,
    resolveToolMemoryPresetId,
    resolveToolMemoryScopeConfigurable,
    type LivingMemoryToolConfigurable
} from '../src/service/memory/tools/tool_runtime'

const context = {
    logger: () => ({ info: () => {}, warn: () => {} })
} as unknown as Context

const mockEngine = {
    searchMemories: async () => []
} as unknown as LivingMemoryEmbeddingSearchEngine

const searchTool = new LivingMemorySearchTool(mockEngine)
const getMessagesTool = new LivingMemoryGetMessagesTool(context)

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

const rejectsStringifiedArray = async (promise: Promise<unknown>) => {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof ToolInputParsingException)
        assert.match(error.message, /Expected array, received string/u)
        return true
    })
}

it('exposes the strict search schema directly to the model-facing tool', async () => {
    assert.equal(searchTool.schema, livingMemorySearchInputSchema)
    assert.match(livingMemorySearchToolDescription, /必填 JSON 数组/u)
    assert.match(
        livingMemorySearchToolDescription,
        /禁止把数组编码成 JSON 字符串/u
    )

    await rejectsStringifiedArray(
        searchTool.invoke({
            searchTexts: '["关系", "称呼"]'
        } as never)
    )
})

it('exposes the strict source-message schema and rejects stringified ids', async () => {
    assert.equal(getMessagesTool.schema, livingMemoryGetMessagesInputSchema)
    assert.match(livingMemoryGetMessagesToolDescription, /必填 JSON 数组/u)
    assert.match(
        livingMemoryGetMessagesToolDescription,
        /禁止把数组编码成 JSON 字符串/u
    )

    await rejectsStringifiedArray(
        getMessagesTool.invoke({ memoryIds: '["memory-1"]' } as never)
    )
})

it('resolves the raw preset for ChatLuna tool calls', () => {
    assert.deepEqual(
        resolveToolMemoryPresetId({
            preset: 'default',
            source: undefined
        }),
        { ok: true, presetId: 'default' }
    )
})

it('appends the Character suffix to the preset for Character tool calls', () => {
    assert.deepEqual(
        resolveToolMemoryPresetId({
            preset: '史尔特里',
            source: 'character'
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
            source: 'character',
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
            source: 'character',
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
            source: 'character'
        }),
        { ok: false, reason: 'missing-session' }
    )

    assert.deepEqual(
        resolveToolMemoryScopeConfigurable({
            preset: '史尔特里',
            source: 'character',
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

    await new LivingMemorySearchTool(chatluna.provider).invoke(
        { searchTexts: ['我们一起聊过的事情'] },
        toolConfig({
            preset: 'default',
            agentContext: {
                kind: 'main',
                conversationId: 'conversation-1'
            },
            source: 'chatluna',
            session: { userId: 'user-1', isDirect: true }
        })
    )
    await new LivingMemorySearchTool(character.provider).invoke(
        { searchTexts: ['我们一起聊过的事情'] },
        toolConfig({
            preset: '史尔特里',
            source: 'character',
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
