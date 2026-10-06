import assert from 'node:assert/strict'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import {
    loadMemorySourceMessages,
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
        getEntriesByPresetAndIds: async (presetId, memoryIds) => {
            requestedPresetId = presetId
            requestedMemoryIds = memoryIds
            return [memory]
        }
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
        getEntriesByPresetAndIds: async () => []
    }

    assert.equal(
        await loadMemorySourceMessages(repository, 'preset-1', 'missing'),
        null
    )
})
