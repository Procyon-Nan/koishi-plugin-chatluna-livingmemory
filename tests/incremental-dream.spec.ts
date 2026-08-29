import assert from 'node:assert/strict'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { Context } from 'koishi'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import type {
    IncrementalDreamNeighborInput,
    IncrementalDreamNeighborSearch
} from '../src/contracts/vector_index'
import type {
    DreamMemoryRepository,
    DreamMergeInput
} from '../src/contracts/workflows'
import { dreamResultToolName } from '../src/service/prompts/schema'
import {
    type IncrementalDreamRepository,
    LivingMemoryIncrementalDreamService
} from '../src/service/workflows/dream/incremental'
import {
    createToolCallingModel,
    createToolCallMessage
} from './tool-calling-test-utils'

const presetId = 'preset-1'
const now = new Date('2026-08-07T00:00:00.000Z')

const createEntry = (
    id: string,
    options: Partial<MemoryEntryRecord> = {}
): MemoryEntryRecord => ({
    id,
    presetId,
    speakerKeys: [],
    type: 'fact',
    status: 'active',
    content: `content-${id}`,
    keywords: [id],
    summary: `summary-${id}`,
    sentiment: 'neutral',
    importance: 0.5,
    sourceConversationId: 'conversation-1',
    sourceOrigins: [],
    isConsolidated: false,
    createdAt: now,
    updatedAt: now,
    ...options
})

class IncrementalRepositoryStub implements IncrementalDreamRepository {
    readonly entries = new Map<string, MemoryEntryRecord>()

    constructor(entries: MemoryEntryRecord[]) {
        entries.forEach((entry) => this.entries.set(entry.id, entry))
    }

    async listPendingEntries(targetPresetId: string, limit: number) {
        return this.list(targetPresetId)
            .filter((entry) => !entry.isConsolidated)
            .sort(
                (left, right) =>
                    +left.createdAt - +right.createdAt ||
                    left.id.localeCompare(right.id)
            )
            .slice(0, limit)
    }

    async getEntriesByPresetAndIds(targetPresetId: string, ids: string[]) {
        const idSet = new Set(ids)
        return this.list(targetPresetId).filter((entry) => idSet.has(entry.id))
    }

    async countPendingEntries(targetPresetId: string) {
        return this.list(targetPresetId).filter(
            (entry) => !entry.isConsolidated
        ).length
    }

    async setMemoryConsolidation(
        targetPresetId: string,
        ids: string[],
        isConsolidated: boolean
    ) {
        const updated: MemoryEntryRecord[] = []
        for (const id of ids) {
            const entry = this.entries.get(id)
            if (entry === undefined || entry.presetId !== targetPresetId) {
                throw new Error(`missing entry: ${id}`)
            }
            entry.isConsolidated = isConsolidated
            updated.push(entry)
        }
        return updated
    }

    async updateMemoryForDream(
        _targetPresetId: string,
        id: string,
        patch: Partial<MemoryEntryRecord>,
        isConsolidated: boolean
    ) {
        const entry = this.entries.get(id)
        if (entry === undefined) throw new Error(`missing entry: ${id}`)
        const previousContent = entry.content
        Object.assign(entry, patch, {
            isConsolidated,
            updatedAt: new Date(+entry.updatedAt + 1)
        })
        return {
            record: entry,
            contentChanged: entry.content !== previousContent
        }
    }

    async applyDreamMerge(input: DreamMergeInput) {
        const target = this.entries.get(input.target.id)
        if (target === undefined) throw new Error('missing target')
        const previousContent = target.content
        const archivedSources: MemoryEntryRecord[] = []
        const deletedSourceIds: string[] = []
        Object.assign(target, input.patch, {
            isConsolidated: input.targetIsConsolidated,
            updatedAt: new Date(+target.updatedAt + 1)
        })
        for (const sourceVersion of input.sources) {
            const source = this.entries.get(sourceVersion.id)
            if (source === undefined) throw new Error('missing source')
            if (input.sourceDisposition === 'delete') {
                this.entries.delete(source.id)
                deletedSourceIds.push(source.id)
            } else {
                source.status = 'archived'
                source.isConsolidated = input.sourceIsConsolidated
                source.updatedAt = new Date(+source.updatedAt + 1)
                archivedSources.push(source)
            }
        }
        return {
            target,
            archivedSources,
            deletedSourceIds,
            targetContentChanged: target.content !== previousContent
        }
    }

    private list(targetPresetId: string) {
        return [...this.entries.values()].filter(
            (entry) => entry.presetId === targetPresetId
        )
    }
}

const emptyResult = () =>
    createToolCallMessage(dreamResultToolName, { operations: [] })

const keepResult = (ids: string[]) =>
    createToolCallMessage(dreamResultToolName, {
        operations: [{ action: 'keep', memoryIds: ids, reason: '保持独立' }]
    })

const mergeResult = (targetMemoryId: string, sourceMemoryId: string) =>
    createToolCallMessage(dreamResultToolName, {
        operations: [
            {
                action: 'merge',
                targetMemoryId,
                sourceMemoryIds: [sourceMemoryId],
                memory: {
                    type: 'fact',
                    content: 'candidate updated by seed one',
                    summary: 'updated candidate',
                    keywords: ['updated'],
                    sentiment: 'neutral',
                    importance: 0.7
                },
                reason: '合并新增信息'
            }
        ]
    })

const createHarness = (
    responses: (BaseMessage | Error)[],
    entries: MemoryEntryRecord[]
) => {
    const model = createToolCallingModel(responses)
    const repository = new IncrementalRepositoryStub(entries)
    const neighborCalls: IncrementalDreamNeighborInput[] = []
    const neighborSearch: IncrementalDreamNeighborSearch = {
        assertPresetReady: () => {},
        findConsolidatedNeighbors: async (input) => {
            neighborCalls.push({
                ...input,
                excludedMemoryIds: [...input.excludedMemoryIds]
            })
            const excludedMemoryIds = new Set(input.excludedMemoryIds)
            return [...repository.entries.values()]
                .filter(
                    (entry) =>
                        entry.presetId === input.presetId &&
                        entry.status === input.status &&
                        entry.isConsolidated &&
                        !excludedMemoryIds.has(entry.id)
                )
                .sort((left, right) => left.id.localeCompare(right.id))
                .slice(0, input.limit)
                .map((entry) => entry.id)
        }
    }
    const ctx = {
        chatluna: {
            createChatModel: async () => ({ value: model.model }),
            preset: {
                getPreset: () => ({ value: {} })
            },
            promptRenderer: {
                renderPresetTemplate: async () => ({ messages: [] })
            }
        }
    } as unknown as Context
    const service = new LivingMemoryIncrementalDreamService(
        ctx,
        {
            mainModel: 'main-model',
            debug: true
        },
        repository,
        repository as DreamMemoryRepository,
        neighborSearch
    )
    return { model, neighborCalls, neighborSearch, repository, service }
}

it('runs one batch unit then consolidates every successful seed in order', async () => {
    const harness = createHarness(
        [emptyResult(), keepResult(['seed-1', 'candidate']), emptyResult()],
        [
            createEntry('seed-1'),
            createEntry('seed-2', {
                createdAt: new Date(+now + 1)
            }),
            createEntry('candidate', { isConsolidated: true })
        ]
    )

    const result = await harness.service.run(presetId, 2)

    assert.equal(result.failed, false)
    assert.equal(result.seedCount, 2)
    assert.equal(result.successfulSeedCount, 2)
    assert.equal(result.remainingPendingCount, 0)
    assert.deepEqual(
        result.stageResults?.map((stageResult) => ({
            stage: stageResult.stage,
            entries: stageResult.entryCount,
            clusters: stageResult.clusterCount
        })),
        [
            { stage: 'active', entries: 2, clusters: 3 },
            { stage: 'archived', entries: 0, clusters: 0 }
        ]
    )
    assert.equal(harness.model.invocations.length, 3)
    assert.equal(harness.repository.entries.get('seed-1')?.isConsolidated, true)
    assert.equal(harness.repository.entries.get('seed-2')?.isConsolidated, true)
})

it('fails before model invocation when the vector index is not ready', async () => {
    const harness = createHarness([], [createEntry('seed-1')])
    harness.neighborSearch.assertPresetReady = () => {
        throw new Error('vector index is not ready')
    }

    await assert.rejects(
        harness.service.run(presetId, 1),
        /vector index is not ready/u
    )
    assert.equal(harness.model.invocations.length, 0)
})

it('continues after a seed structured-output failure and leaves it pending', async () => {
    const harness = createHarness(
        [
            emptyResult(),
            emptyResult(),
            new AIMessage('invalid one'),
            new AIMessage('invalid two'),
            new AIMessage('invalid three')
        ],
        [
            createEntry('seed-1'),
            createEntry('seed-2', { createdAt: new Date(+now + 1) }),
            createEntry('candidate', { isConsolidated: true })
        ]
    )

    const result = await harness.service.run(presetId, 2)

    assert.equal(result.failed, true)
    assert.equal(result.successfulSeedCount, 1)
    assert.equal(result.failedSeedCount, 1)
    assert.equal(harness.repository.entries.get('seed-1')?.isConsolidated, true)
    assert.equal(
        harness.repository.entries.get('seed-2')?.isConsolidated,
        false
    )
})

it('rejects non-empty seed operations that do not reference the seed', async () => {
    const harness = createHarness(
        [emptyResult(), keepResult(['candidate'])],
        [
            createEntry('seed-1'),
            createEntry('candidate', { isConsolidated: true })
        ]
    )

    const result = await harness.service.run(presetId, 1)

    assert.equal(result.failed, true)
    assert.equal(result.failedSeedCount, 1)
    assert.equal(
        harness.repository.entries.get('seed-1')?.isConsolidated,
        false
    )
})

it('stops after a first-round failure without consolidating the batch', async () => {
    const harness = createHarness(
        [
            new AIMessage('invalid one'),
            new AIMessage('invalid two'),
            new AIMessage('invalid three')
        ],
        [
            createEntry('seed-1'),
            createEntry('candidate', { isConsolidated: true })
        ]
    )

    const result = await harness.service.run(presetId, 1)

    assert.equal(result.failed, true)
    assert.equal(result.seedCount, 0)
    assert.equal(
        harness.repository.entries.get('seed-1')?.isConsolidated,
        false
    )
})

it('refreshes a mutated old candidate before processing the next seed', async () => {
    const harness = createHarness(
        [
            emptyResult(),
            mergeResult('candidate', 'seed-1'),
            keepResult(['seed-2', 'candidate'])
        ],
        [
            createEntry('seed-1'),
            createEntry('seed-2', { createdAt: new Date(+now + 1) }),
            createEntry('candidate', {
                content: 'original candidate',
                isConsolidated: true
            })
        ]
    )

    const result = await harness.service.run(presetId, 2)

    assert.equal(result.failed, false)
    const finalInput = harness.model.invocations[2]?.messages[1]
    assert.match(String(finalInput?.content), /candidate updated by seed one/u)
    assert.deepEqual(
        harness.neighborCalls.map((call) => call.seedMemoryId),
        ['seed-1', 'seed-2']
    )
})

it('queries the latest index state for every sequential seed', async () => {
    const harness = createHarness(
        [emptyResult(), emptyResult(), emptyResult()],
        [
            createEntry('seed-1'),
            createEntry('seed-2', { createdAt: new Date(+now + 1) }),
            createEntry('candidate', { isConsolidated: true })
        ]
    )

    const result = await harness.service.run(presetId, 2)

    assert.equal(result.failed, false)
    assert.equal(harness.neighborCalls.length, 2)
    assert.deepEqual(harness.neighborCalls[0].excludedMemoryIds, [
        'seed-1',
        'seed-2'
    ])
    assert.deepEqual(harness.neighborCalls[1].excludedMemoryIds, [
        'seed-1',
        'seed-2'
    ])
})

it('limits each seed relation unit to the 30 nearest old memories', async () => {
    const candidates = Array.from({ length: 31 }, (_, index) =>
        createEntry(`candidate-${index.toString().padStart(2, '0')}`, {
            isConsolidated: true
        })
    )
    const harness = createHarness(
        [emptyResult(), keepResult(['seed-1'])],
        [createEntry('seed-1'), ...candidates]
    )

    const result = await harness.service.run(presetId, 1)

    assert.equal(result.failed, false)
    const relationInput = String(
        harness.model.invocations[1]?.messages[1]?.content
    )
    assert.match(relationInput, /candidate-29/u)
    assert.doesNotMatch(relationInput, /candidate-30/u)
})
