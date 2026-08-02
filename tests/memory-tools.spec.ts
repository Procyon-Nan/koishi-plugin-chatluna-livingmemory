import assert from 'node:assert/strict'
import { ToolInputParsingException } from '@langchain/core/tools'
import type { Context } from 'koishi'
import {
    LivingMemoryGetMessagesTool,
    livingMemoryGetMessagesToolDescription
} from '../src/service/memory/tools/get_messages_tool'
import {
    livingMemoryEmbeddingSearchInputSchema,
    livingMemoryGetMessagesInputSchema
} from '../src/service/memory/tools/search_contract'
import {
    livingMemoryEmbeddingSearchToolDescription,
    LivingMemoryEmbeddingSearchTool
} from '../src/service/memory/tools/embedding_search_tool'
import {
    createEmbeddingSearchCache,
    type LivingMemoryEmbeddingSearchEngine
} from '../src/service/workflows/recall/embedding_search_engine'

const context = {
    logger: () => ({ info: () => {}, warn: () => {} })
} as unknown as Context

const mockEngine = {
    search: async () => []
} as unknown as LivingMemoryEmbeddingSearchEngine

const searchTool = new LivingMemoryEmbeddingSearchTool(
    mockEngine,
    createEmbeddingSearchCache(),
    context,
    { debug: false, memorySearchToolMaxResults: 30 }
)
const getMessagesTool = new LivingMemoryGetMessagesTool(context, {
    debug: false
})

const rejectsStringifiedArray = async (promise: Promise<unknown>) => {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof ToolInputParsingException)
        assert.match(error.message, /Expected array, received string/u)
        return true
    })
}

it('exposes the strict search schema directly to the model-facing tool', async () => {
    assert.equal(searchTool.schema, livingMemoryEmbeddingSearchInputSchema)
    assert.match(
        livingMemoryEmbeddingSearchToolDescription,
        /required JSON array/u
    )
    assert.match(
        livingMemoryEmbeddingSearchToolDescription,
        /Never encode an array/u
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
    assert.match(livingMemoryGetMessagesToolDescription, /required JSON array/u)
    assert.match(livingMemoryGetMessagesToolDescription, /Never encode it/u)

    await rejectsStringifiedArray(
        getMessagesTool.invoke({ memoryIds: '["memory-1"]' } as never)
    )
})
