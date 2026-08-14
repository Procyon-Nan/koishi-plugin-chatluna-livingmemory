import assert from 'node:assert/strict'
import { ToolInputParsingException } from '@langchain/core/tools'
import type { Context } from 'koishi'
import { LivingMemoryLogger } from '../src/service/logging/logger'
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
import { LivingMemoryToolRuntime } from '../src/service/memory/tools/tool_runtime'

const context = {
    logger: () => ({ info: () => {}, warn: () => {} })
} as unknown as Context

const mockEngine = {
    searchMemories: async () => []
} as unknown as LivingMemoryEmbeddingSearchEngine

const silentLogger = new LivingMemoryLogger(
    { info: () => {}, warn: () => {}, error: () => {} } as never,
    () => false
)
const searchTool = new LivingMemorySearchTool(mockEngine, silentLogger)
const getMessagesTool = new LivingMemoryGetMessagesTool(context, silentLogger)

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
            searchTexts: '["关系", "称呼"]',
            memoryTypes: '["all"]'
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

it('does not serialize tool payloads when debug logging is disabled', () => {
    let serialized = false
    const runtime = new LivingMemoryToolRuntime({
        toolName: 'test_tool',
        logger: silentLogger
    })

    runtime.logInput(undefined, {
        toJSON: () => {
            serialized = true
            return {}
        }
    })

    assert.equal(serialized, false)
})

it('keeps ordinary tool debug logs free of payload content', () => {
    const messages: string[] = []
    const runtime = new LivingMemoryToolRuntime({
        toolName: 'test_tool',
        logger: new LivingMemoryLogger(
            {
                info: (message: unknown) => messages.push(String(message)),
                warn: () => {},
                error: () => {}
            } as never,
            () => true
        )
    })

    runtime.logInput({ preset: 'preset-1' }, { query: 'private conversation' })

    assert.equal(messages.length, 1)
    assert.match(messages[0], /inputLength=\d+/u)
    assert.doesNotMatch(messages[0], /private conversation/u)
})
