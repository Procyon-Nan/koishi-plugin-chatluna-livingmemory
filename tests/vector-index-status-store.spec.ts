import assert from 'node:assert/strict'
import type {
    MemoryVectorIndexManifest,
    MemoryVectorIndexPresetStatus
} from '../src/contracts/vector_index'
import { VectorIndexStatusStore } from '../src/service/vector_index/status_store'
import type { VectorIndexInspection } from '../src/service/vector_index/worker_protocol'

const createManifest = (): MemoryVectorIndexManifest => ({
    schemaVersion: 4,
    embeddingModelId: 'model-a',
    dimension: 3,
    storageEngine: 'pglite-pgvector',
    vectorExtensionVersion: '0.8.1',
    generation: 'generation-1',
    builtAt: 1
})

const createPreset = (
    presetId: string,
    state: MemoryVectorIndexPresetStatus['state']
): MemoryVectorIndexPresetStatus => ({
    presetId,
    state,
    expectedCount: 2,
    indexedCount: 2,
    lastError: null,
    updatedAt: 1
})

const createInspection = (
    presets: MemoryVectorIndexPresetStatus[]
): VectorIndexInspection => ({
    vectorExtensionVersion: '0.8.1',
    manifest: createManifest(),
    indexedCount: presets.length,
    inventory: [],
    presets
})

it('blocks reads before the first inspection lands', () => {
    const store = new VectorIndexStatusStore()
    assert.throws(
        () => store.assertPresetReady('preset-a'),
        /vector index is not ready: state=building/u
    )
    assert.equal(store.snapshot().state, 'building')
    assert.equal(store.snapshot().manifest, null)
})

it('lets ready presets pass and tolerates presets without a row', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    assert.doesNotThrow(() => store.assertPresetReady('preset-a'))
    assert.doesNotThrow(() => store.assertPresetReady('preset-new'))
    assert.equal(store.snapshot().state, 'ready')
})

it('keeps a dirty preset from blocking other presets', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(
        createInspection([
            createPreset('preset-a', 'dirty'),
            createPreset('preset-b', 'ready')
        ])
    )
    assert.throws(
        () => store.assertPresetReady('preset-a'),
        /vector index preset is not ready: preset=preset-a, state=dirty/u
    )
    assert.doesNotThrow(() => store.assertPresetReady('preset-b'))
    assert.equal(store.snapshot().state, 'dirty')
})

it('keeps the maintenance window open until its opener ends it', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(
        createInspection([
            createPreset('preset-a', 'ready'),
            createPreset('preset-b', 'ready')
        ])
    )
    store.markStarting()
    for (const presetId of ['preset-a', 'preset-b']) {
        assert.throws(
            () => store.assertPresetReady(presetId),
            /vector index is not ready: state=building/u
        )
    }
    assert.equal(store.snapshot().state, 'building')

    store.markBuilding('job-1')
    assert.equal(store.snapshot().currentJobId, 'job-1')
    // 任意任务结束（含按预设对账任务）只清 jobId，无权关闭窗口。
    store.setCurrentJob(null)
    assert.throws(
        () => store.assertPresetReady('preset-a'),
        /vector index is not ready: state=building/u
    )

    store.endMaintenance()
    assert.doesNotThrow(() => store.assertPresetReady('preset-a'))
    assert.equal(store.snapshot().state, 'ready')
})

it('holds the window while overlapping maintenance tasks drain', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    store.markStarting()
    store.markStarting()
    store.endMaintenance()
    assert.throws(
        () => store.assertPresetReady('preset-a'),
        /vector index is not ready: state=building/u
    )
    store.endMaintenance()
    assert.doesNotThrow(() => store.assertPresetReady('preset-a'))
    assert.equal(store.snapshot().state, 'ready')
})

it('blocks every preset while the runtime is unavailable', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    store.markUnavailable('worker crashed')
    assert.throws(
        () => store.assertPresetReady('preset-a'),
        /vector index is not ready: state=unavailable/u
    )
    const snapshot = store.snapshot()
    assert.equal(snapshot.state, 'unavailable')
    assert.equal(snapshot.lastError, 'worker crashed')

    store.reset()
    assert.equal(store.snapshot().state, 'building')
})

it('clears the runtime unavailable state after recovery', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    store.markUnavailable('embedding unavailable')

    store.clearUnavailable()

    assert.doesNotThrow(() => store.assertPresetReady('preset-a'))
    assert.equal(store.snapshot().state, 'ready')
    assert.equal(store.snapshot().lastError, null)
})

it('ends the maintenance window when a maintenance task fails', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    store.markStarting()
    store.markRuntimeError('embedding unavailable')
    store.endMaintenance()
    assert.doesNotThrow(() => store.assertPresetReady('preset-a'))
    assert.equal(store.snapshot().state, 'ready')
    assert.equal(store.snapshot().lastError, 'embedding unavailable')
})

it('keeps per-preset building marks display-only across inspections', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    store.markPresetBuilding('preset-a', 'job-1', 5)
    store.markPresetBuilding('preset-ghost', 'job-1', 3)

    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    assert.doesNotThrow(() => store.assertPresetReady('preset-a'))

    const snapshot = store.snapshot()
    assert.equal(snapshot.state, 'building')
    assert.deepEqual(
        snapshot.presets.map((preset) => [preset.presetId, preset.state]),
        [
            ['preset-a', 'building'],
            ['preset-ghost', 'building']
        ]
    )

    store.clearPresetBuilding('preset-a')
    store.clearPresetBuilding('preset-ghost')
    assert.equal(store.snapshot().state, 'ready')
    assert.deepEqual(
        store.snapshot().presets.map((preset) => preset.presetId),
        ['preset-a']
    )
})

it('reads indexed counts from the inspection mirror', () => {
    const store = new VectorIndexStatusStore()
    store.applyInspection(createInspection([createPreset('preset-a', 'ready')]))
    assert.equal(store.getPresetIndexedCount('preset-a'), 2)
    assert.equal(store.getPresetIndexedCount('preset-b'), 0)
})
