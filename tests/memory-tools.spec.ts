import assert from 'node:assert/strict'
import { ToolInputParsingException } from '@langchain/core/tools'
import type { Context } from 'koishi'
import {
    LivingMemoryGetMessagesTool,
    livingMemoryGetMessagesToolDescription
} from '../src/service/memory/tools/get_messages_tool'
import {
    livingMemoryGetMessagesInputSchema,
    livingMemorySearchInputSchema
} from '../src/service/memory/tools/search_contract'
import {
    LivingMemorySearchTool,
    livingMemorySearchToolDescription
} from '../src/service/memory/tools/search_tool'

const context = {
    logger: () => ({ info: () => {}, warn: () => {} })
} as unknown as Context

const searchTool = new LivingMemorySearchTool(context, {
    debug: false,
    memorySearchToolMaxResults: 30
})
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
    assert.equal(searchTool.schema, livingMemorySearchInputSchema)
    assert.match(livingMemorySearchToolDescription, /required JSON array/u)
    assert.match(livingMemorySearchToolDescription, /Never encode an array/u)

    await rejectsStringifiedArray(
        searchTool.invoke({
            broadSearchTexts: '["关系", "称呼"]',
            specificSearchTexts: '["蔷薇称Procyon为爸爸"]',
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
