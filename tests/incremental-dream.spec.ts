import assert from 'node:assert/strict'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { Context } from 'koishi'
import type { MemoryEntryRecord } from '../src/contracts/memory'
import type { DreamMergeInput } from '../src/contracts/workflows'
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
    type: 'fact',
    status: 'active',
    content: `content-${id}`,
    keywords: [id],
    summary: `summary-${id}`,
    sentiment: 'neutral',
    importance: 0.5,
    sourceConversationId: 'conversation-1',
    sourceOrigins: [],
    embedding: null,
    embeddingModelId: null,
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

    async listConsolidatedEntries(targetPresetId: string) {
        return this.list(targetPresetId).filter((entry) => entry.isConsolidated)
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

    async setMemoryConsolidation(ids: string[], isConsolidated: boolean) {
        for (const id of ids) {
            const entry = this.entries.get(id)
            if (entry === undefined) {
                throw new Error(`missing entry: ${id}`)
            }
            entry.isConsolidated = isConsolidated
        }
    }

    async updateMemoryForDream(
        id: string,
        patch: Partial<MemoryEntryRecord>,
        isConsolidated: boolean
    ) {
        const entry = this.entries.get(id)
        if (entry === undefined) throw new Error(`missing entry: ${id}`)
        Object.assign(entry, patch, {
            isConsolidated,
            embedding: null,
            embeddingModelId: null,
            updatedAt: new Date(+entry.updatedAt + 1)
        })
    }

    async applyDreamMerge(input: DreamMergeInput) {
        const target = this.entries.get(input.target.id)
        if (target === undefined) throw new Error('missing target')
        Object.assign(target, input.patch, {
            sourceOrigins: input.sourceOrigins,
            isConsolidated: input.targetIsConsolidated,
            embedding: null,
            embeddingModelId: null,
            updatedAt: new Date(+target.updatedAt + 1)
        })
        for (const sourceVersion of input.sources) {
            const source = this.entries.get(sourceVersion.id)
            if (source === undefined) throw new Error('missing source')
            if (input.sourceDisposition === 'delete') {
                this.entries.delete(source.id)
            } else {
                source.status = 'archived'
                source.isConsolidated = input.sourceIsConsolidated
                source.updatedAt = new Date(+source.updatedAt + 1)
            }
        }
    }

    async updateEntryEmbeddings(
        updates: {
            id: string
            embedding: number[]
            embeddingModelId: string
        }[]
    ) {
        for (const update of updates) {
            const entry = this.entries.get(update.id)
            if (entry === undefined) {
                throw new Error(`missing entry: ${update.id}`)
            }
            entry.embedding = update.embedding
            entry.embeddingModelId = update.embeddingModelId
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
    const embeddedDocuments: string[][] = []
    const vectorFor = (text: string) =>
        text.includes('distant') ? [0, 1] : [1, 0]
    const ctx = {
        chatluna: {
            createChatModel: async () => ({ value: model.model }),
            createEmbeddings: async () => ({
                value: {
                    embedQuery: async (text: string) => vectorFor(text),
                    embedDocuments: async (texts: string[]) => {
                        embeddedDocuments.push([...texts])
                        return texts.map(vectorFor)
                    }
                }
            }),
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
            embeddingModel: 'embedding-model',
            debug: true
        },
        repository,
        () => {}
    )
    return { embeddedDocuments, model, repository, service }
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
    assert.equal(harness.model.invocations.length, 3)
    assert.equal(harness.repository.entries.get('seed-1')?.isConsolidated, true)
    assert.equal(harness.repository.entries.get('seed-2')?.isConsolidated, true)
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
    assert.deepEqual(harness.embeddedDocuments, [
        ['content-seed-1', 'original candidate'],
        ['content-seed-2', 'candidate updated by seed one']
    ])
})

it('reuses unchanged candidate embeddings across sequential seeds', async () => {
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
    assert.deepEqual(harness.embeddedDocuments, [
        ['content-seed-1', 'content-candidate'],
        ['content-seed-2']
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
