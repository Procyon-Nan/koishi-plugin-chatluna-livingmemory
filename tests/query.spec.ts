import assert from 'node:assert/strict'
import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType
} from '../src/contracts/memory'
import { filterMemoryList } from '../src/query'

const createMemory = (
    index: number,
    type: MemoryEntryType,
    status: MemoryEntryStatus
): MemoryEntryRecord => {
    const createdAt = new Date(Date.UTC(2026, 6, 1, 0, 0, index))
    return {
        id: `memory-${index}`,
        presetId: 'preset-1',
        type,
        status,
        content: `content-${index}`,
        keywords: [`keyword-${index}`],
        summary: null,
        sentiment: null,
        importance: null,
        sourceConversationId: null,
        sourceOrigins: [],
        embedding: null,
        embeddingModelId: null,
        isConsolidated: false,
        createdAt,
        updatedAt: createdAt
    }
}

it('returns complete memory facets independently from pagination limits', () => {
    const items = Array.from({ length: 150 }, (_, index) => {
        const status = index < 90 ? 'active' : 'archived'
        const type = index % 3 === 0 ? 'fact' : 'preference'
        return createMemory(index, type, status)
    })

    const result = filterMemoryList(items, {
        presetId: 'preset-1',
        page: 1,
        pageSize: 100000
    })

    assert.equal(result.items.length, 100)
    assert.equal(result.pageSize, 100)
    assert.deepEqual(result.facets.statuses, {
        active: 90,
        archived: 60,
        all: 150
    })
    assert.equal(result.facets.types.active.fact, 30)
    assert.equal(result.facets.types.active.preference, 60)
    assert.equal(result.facets.types.archived.fact, 20)
    assert.equal(result.facets.types.archived.preference, 40)
    assert.equal(result.facets.types.all.fact, 50)
    assert.equal(result.facets.types.all.preference, 100)
})

it('keeps facets preset-wide while filtering the returned memory page', () => {
    const items = [
        createMemory(1, 'fact', 'active'),
        createMemory(2, 'plan', 'active'),
        createMemory(3, 'fact', 'archived')
    ]

    const result = filterMemoryList(items, {
        presetId: 'preset-1',
        type: 'fact',
        status: 'active',
        keyword: 'content-1'
    })

    assert.deepEqual(
        result.items.map((item) => item.id),
        ['memory-1']
    )
    assert.equal(result.total, 1)
    assert.deepEqual(result.facets.statuses, {
        active: 2,
        archived: 1,
        all: 3
    })
    assert.equal(result.facets.types.active.fact, 1)
    assert.equal(result.facets.types.active.plan, 1)
    assert.equal(result.facets.types.archived.fact, 1)
})
