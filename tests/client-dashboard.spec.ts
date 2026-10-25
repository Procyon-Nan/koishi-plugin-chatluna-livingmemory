import assert from 'node:assert/strict'
import { usePagedResource } from '../client/composables/use-paged-resource'
import type { MemoryVectorIndexStatus } from '../src/contracts/vector_index'
import { isVectorWorkflowReady } from '../client/utils/vector-index'

const vectorStatus = (
    state: MemoryVectorIndexStatus['state'],
    presetState: MemoryVectorIndexStatus['state'] = state
): MemoryVectorIndexStatus => ({
    state,
    manifest: null,
    presets: [
        {
            presetId: 'preset-1',
            state: presetState,
            expectedCount: 10,
            indexedCount: 10,
            lastError: null,
            updatedAt: Date.now()
        }
    ],
    currentJobId: null,
    lastError: null
})

it('enables vector workflows only when the global and preset indexes are ready', () => {
    assert.equal(isVectorWorkflowReady(vectorStatus('ready'), 'preset-1'), true)
    assert.equal(
        isVectorWorkflowReady(vectorStatus('ready', 'building'), 'preset-1'),
        false
    )
    assert.equal(
        isVectorWorkflowReady(vectorStatus('dirty'), 'preset-1'),
        false
    )
    assert.equal(
        isVectorWorkflowReady(vectorStatus('unavailable'), 'preset-1'),
        false
    )
    assert.equal(isVectorWorkflowReady(vectorStatus('ready'), ''), false)
    assert.equal(
        isVectorWorkflowReady(vectorStatus('ready'), 'empty-preset'),
        true
    )
})

it('tracks paged client resources and resets the page when page size changes', async () => {
    const calls: Array<[number, number]> = []
    const resource = usePagedResource(async (page, pageSize) => {
        calls.push([page, pageSize])
        return {
            items: [`${page}:${pageSize}`],
            page,
            pageSize,
            total: 42
        }
    })

    await resource.refresh()
    assert.deepEqual(resource.items.value, ['1:20'])
    assert.equal(resource.total.value, 42)

    await resource.changePage(2)
    assert.deepEqual(resource.items.value, ['2:20'])

    await resource.changePageSize(50)
    assert.equal(resource.page.value, 1)
    assert.deepEqual(resource.items.value, ['1:50'])
    assert.deepEqual(calls, [
        [1, 20],
        [2, 20],
        [1, 50]
    ])
})

it('restores paged resource loading state after loader failures', async () => {
    const resource = usePagedResource<string>(async () => {
        throw new Error('load failed')
    })

    await assert.rejects(resource.refresh(), /load failed/)
    assert.equal(resource.loading.value, false)
})
