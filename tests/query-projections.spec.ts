import assert from 'node:assert/strict'
import type {
    MemoryEntryRecord,
    MemorySnapshotRecord
} from '../src/contracts/memory'
import {
    loadMemorySourceMessages,
    listResolvedMemorySnapshots,
    type LivingMemoryQueryProjectionRepository
} from '../src/service/app/query_projections'

const createMemory = (
    id: string,
    overrides: Partial<MemoryEntryRecord> = {}
): MemoryEntryRecord => ({
    id,
    presetId: 'preset-1',
    speakerKeys: [],
    type: 'fact',
    status: 'active',
    content: `content-${id}`,
    keywords: [`keyword-${id}`],
    summary: `summary-${id}`,
    sentiment: null,
    importance: 0.5,
    sourceConversationId: 'conversation-1',
    sourceLabel: null,
    sourceOrigins: [],
    isConsolidated: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    ...overrides
})

it('projects the source messages of one memory without sharing mutable arrays', async () => {
    const memory = createMemory('memory-1', {
        sourceLabel: '来源于「摸鱼群」（群聊 ID：10001）的群聊',
        sourceOrigins: [
            {
                messages: [
                    {
                        role: 'user',
                        speakerLabel: 'Alice',
                        contentLines: ['line-1', 'line-2'],
                        transcriptLines: ['Alice: line-1'],
                        createdAt: '2026-07-01T00:00:00.000Z',
                        content: 'line-1\nline-2'
                    }
                ]
            }
        ]
    })
    let requestedPresetId: string | undefined
    let requestedMemoryIds: string[] = []
    const repository: LivingMemoryQueryProjectionRepository = {
        getEntriesByIds: async () => [],
        getEntriesByPresetAndIds: async (presetId, memoryIds) => {
            requestedPresetId = presetId
            requestedMemoryIds = memoryIds
            return [memory]
        },
        listSnapshotsByPreset: async () => []
    }

    const result = await loadMemorySourceMessages(
        repository,
        'preset-1',
        'memory-1'
    )

    assert.equal(requestedPresetId, 'preset-1')
    assert.deepEqual(requestedMemoryIds, ['memory-1'])
    assert.deepEqual(result, {
        id: 'memory-1',
        sourceLabel: '来源于「摸鱼群」（群聊 ID：10001）的群聊',
        sourceOrigins: [{ messages: memory.sourceOrigins[0].messages }]
    })
    assert.notStrictEqual(
        result?.sourceOrigins[0].messages,
        memory.sourceOrigins[0].messages
    )
    assert.notStrictEqual(
        result?.sourceOrigins[0].messages[0].contentLines,
        memory.sourceOrigins[0].messages[0].contentLines
    )
})

it('returns null when the memory is absent from the preset', async () => {
    const repository: LivingMemoryQueryProjectionRepository = {
        getEntriesByIds: async () => [],
        getEntriesByPresetAndIds: async () => [],
        listSnapshotsByPreset: async () => []
    }

    assert.equal(
        await loadMemorySourceMessages(repository, 'preset-1', 'missing'),
        null
    )
})

it('resolves only memory references from the requested snapshot page', async () => {
    const memory = createMemory('memory-1')
    const snapshots: MemorySnapshotRecord[] = [
        {
            id: 'snapshot-older',
            presetId: 'preset-1',
            conversationId: 'conversation-1',
            strategy: 'embedding-rerank',
            query: 'older',
            items: [{ memoryId: 'memory-outside-page', score: 0.4 }],
            createdAt: new Date('2026-07-01T00:00:00.000Z')
        },
        {
            id: 'snapshot-latest',
            presetId: 'preset-1',
            conversationId: 'conversation-1',
            strategy: 'embedding-rerank',
            query: 'latest',
            items: [
                { memoryId: memory.id, score: 0.9 },
                { memoryId: 'missing-memory', score: 0.3 },
                { memoryId: memory.id, score: 0.2 }
            ],
            createdAt: new Date('2026-07-03T00:00:00.000Z')
        },
        {
            id: 'snapshot-other-conversation',
            presetId: 'preset-1',
            conversationId: 'conversation-2',
            strategy: 'embedding-rerank',
            query: 'other',
            items: [{ memoryId: 'memory-other-conversation' }],
            createdAt: new Date('2026-07-04T00:00:00.000Z')
        }
    ]
    let requestedPresetId: string | undefined
    let requestedMemoryIds: string[] = []
    const repository: LivingMemoryQueryProjectionRepository = {
        getEntriesByIds: async (memoryIds) => {
            requestedMemoryIds = memoryIds
            return [memory]
        },
        getEntriesByPresetAndIds: async () => [],
        listSnapshotsByPreset: async (presetId) => {
            requestedPresetId = presetId
            return snapshots
        }
    }

    const result = await listResolvedMemorySnapshots(repository, {
        presetId: 'preset-1',
        conversationId: 'conversation-1',
        page: 1,
        pageSize: 1
    })

    assert.equal(requestedPresetId, 'preset-1')
    assert.deepEqual(requestedMemoryIds, [memory.id, 'missing-memory'])
    assert.equal(result.total, 2)
    assert.equal(result.page, 1)
    assert.equal(result.pageSize, 1)
    assert.equal(result.items[0].id, 'snapshot-latest')
    assert.deepEqual(result.items[0].resolvedItems, [
        {
            memoryId: memory.id,
            score: 0.9,
            memory,
            missing: false
        },
        {
            memoryId: 'missing-memory',
            score: 0.3,
            memory: null,
            missing: true
        },
        {
            memoryId: memory.id,
            score: 0.2,
            memory,
            missing: false
        }
    ])
})
