import assert from 'node:assert/strict'
import type { LivingMemoryRepository } from '../src/service/persistence/repository'
import { withLivingMemoryRepository } from './persistence-test-utils'

const createPresetData = async (
    repository: LivingMemoryRepository,
    presetId: string
) => {
    const scope = {
        conversationId: `${presetId}-conversation`,
        presetId
    }
    await repository.createMemory(scope, {
        type: 'fact',
        content: `${presetId} memory`
    })
    await repository.upsertSnapshot(
        scope,
        'embedding-rerank',
        `${presetId} query`,
        []
    )
    await repository.createJob(scope, 'dream', `${presetId} input`)
    await repository.upsertPresetSpeaker({
        presetId,
        speakerKey: `${presetId}-speaker`,
        speakerLabel: `${presetId} speaker`
    })
    await repository.replaceUserProfile(presetId, {
        speakerKey: `${presetId}-speaker`,
        speakerLabel: `${presetId} speaker`,
        content: `${presetId} profile`,
        sourceMemoryIds: []
    })
}

it('lists stored presets and clears only the selected preset', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        await createPresetData(repository, 'preset-clear')
        await createPresetData(repository, 'preset-keep')

        assert.deepEqual(
            (await repository.listDistinctPresetIds()).sort(),
            ['preset-clear', 'preset-keep']
        )

        await repository.clearAllByPreset('preset-clear')

        const targetCounts = await Promise.all([
            ctx.database.get('living_memory_entry', {
                presetId: 'preset-clear'
            }),
            ctx.database.get('living_memory_snapshot', {
                presetId: 'preset-clear'
            }),
            ctx.database.get('living_memory_job', {
                presetId: 'preset-clear'
            }),
            ctx.database.get('living_memory_user_profile', {
                presetId: 'preset-clear'
            }),
            ctx.database.get('living_memory_preset_speaker', {
                presetId: 'preset-clear'
            })
        ])
        assert.ok(targetCounts.every((records) => records.length === 0))

        const retainedCounts = await Promise.all([
            ctx.database.get('living_memory_entry', {
                presetId: 'preset-keep'
            }),
            ctx.database.get('living_memory_snapshot', {
                presetId: 'preset-keep'
            }),
            ctx.database.get('living_memory_job', {
                presetId: 'preset-keep'
            }),
            ctx.database.get('living_memory_user_profile', {
                presetId: 'preset-keep'
            }),
            ctx.database.get('living_memory_preset_speaker', {
                presetId: 'preset-keep'
            })
        ])
        assert.ok(retainedCounts.every((records) => records.length === 1))
        assert.deepEqual(await repository.listDistinctPresetIds(), [
            'preset-keep'
        ])
    })
})
