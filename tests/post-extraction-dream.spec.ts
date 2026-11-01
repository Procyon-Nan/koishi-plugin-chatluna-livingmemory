import assert from 'node:assert/strict'
import {
    buildPostExtractionDreamBatches,
    refreshPostExtractionDreamBatch
} from '../src/service/workflows/dream/post_extraction'
import {
    advanceDreamBatch,
    assertDreamMemoriesAvailable,
    createDreamSessionState,
    getDreamCoverage,
    recordDreamOperation
} from '../src/service/workflows/dream/session/state'
import { LivingMemoryDreamCoordinator } from '../src/service/workflows/dream/coordinator'
import {
    createMemoryEntry,
    createJobStore,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'

it('excludes the whole extraction and skips a seed with no neighbors', async () => {
    const entries = ['x', 'y', 'a'].map((id) => createMemoryEntry(id))
    const plan = await buildPostExtractionDreamBatches(
        scope.presetId,
        ['x', 'y'],
        entries.slice(0, 2),
        {
            getEntriesByPresetAndIds: async (_preset, ids) =>
                entries.filter((entry) => ids.includes(entry.id))
        },
        {
            searchMemoriesDetailed: async (
                _preset,
                input,
                conversationId,
                excluded
            ) => {
                assert.deepEqual(excluded, ['x', 'y'])
                assert.equal(conversationId, undefined)
                assert.deepEqual(input.searchKeywords, [])
                return input.searchTexts[0] === 'content-x'
                    ? [
                          {
                              ...entries[2],
                              cosineScore: 0.9,
                              keywordMatchCount: 0,
                              boostedScore: 0.9,
                              rerankScore: null
                          }
                      ]
                    : []
            }
        },
        logger
    )
    assert.deepEqual(
        plan.batches.map((batch) => batch.entries.map((entry) => entry.id)),
        [['x', 'a']]
    )
    assert.deepEqual(plan.untouchedSeedIds, ['y'])
})

it('refreshes original members and drops archived sources without substituting replacements', async () => {
    const batch = {
        id: 'y',
        seedMemoryId: 'y',
        entries: ['y', 'a', 'b'].map((id) => createMemoryEntry(id))
    }
    const records = [
        createMemoryEntry('y'),
        { ...createMemoryEntry('a'), content: 'new content' },
        createMemoryEntry('b', 'archived'),
        createMemoryEntry('replacement')
    ]
    const repository = {
        getEntriesByPresetAndIds: async (_preset: string, ids: string[]) =>
            records.filter((entry) => ids.includes(entry.id)),
        listPresetSpeakers: async () => []
    }
    const loaded = await refreshPostExtractionDreamBatch(
        scope.presetId,
        batch,
        repository
    )
    assert.deepEqual(
        loaded!.entries.map((entry) => entry.id),
        ['y', 'a']
    )
    assert.equal(loaded!.entries[1].content, 'new content')
    records[1].status = 'archived'
    assert.equal(
        await refreshPostExtractionDreamBatch(
            scope.presetId,
            batch,
            repository
        ),
        undefined
    )
})

it('resets group permissions and keeps an earlier group omission after later success', () => {
    const state = createDreamSessionState(['x', 'y'], 'post-extraction')
    state.batches = [
        ['x', 'a'],
        ['y', 'a']
    ].map((ids) => ({
        id: ids[0],
        seedMemoryId: ids[0],
        entries: ids.map((id) => createMemoryEntry(id))
    }))
    advanceDreamBatch(state)
    recordDreamOperation(state, ['x'], 'kept')
    state.availableMemoryIds.add('replacement')
    advanceDreamBatch(state)
    assert.throws(() =>
        assertDreamMemoriesAvailable(state, ['x', 'replacement'])
    )
    assert.equal(state.processedMemoryIds.has('a'), false)
    recordDreamOperation(state, ['y', 'a'], 'kept')
    advanceDreamBatch(state)
    assert.deepEqual(getDreamCoverage(state), {
        targetCount: 4,
        processedCount: 3,
        unprocessedMemoryIds: ['a']
    })
})

it('queues extraction tasks FIFO and creates jobs only when they run', async () => {
    const store = createJobStore()
    const started: string[][] = []
    let release!: () => void
    const first = new Promise<void>((resolve) => {
        release = resolve
    })
    const coordinator = new LivingMemoryDreamCoordinator(
        {
            run: async (_scope, _id, _signal, input) => {
                assert.equal(input!.mode, 'post-extraction')
                if (input!.mode !== 'post-extraction') return
                started.push(input!.memoryIds)
                if (started.length === 1) await first
            }
        },
        { ...store, countActiveEntries: async () => 1 },
        logger
    )
    coordinator.queueAfterExtraction(scope.presetId, ['x'])
    coordinator.queueAfterExtraction(scope.presetId, ['y'])
    await waitFor(() => started.length === 1, 'first post-extraction task')
    assert.equal(store.jobs.length, 1)
    assert.equal(
        (await coordinator.start(scope.presetId)).reason,
        'preset-locked'
    )
    release()
    await waitFor(() => started.length === 2, 'second post-extraction task')
    await coordinator.stop()
    assert.deepEqual(started, [['x'], ['y']])
    assert.equal(store.jobs.length, 2)
    coordinator.queueAfterExtraction(scope.presetId, ['z'])
    assert.equal(store.jobs.length, 2)
})
