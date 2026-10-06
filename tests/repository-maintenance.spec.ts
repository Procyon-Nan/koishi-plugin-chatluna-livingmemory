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
    await repository.createMemory(
        scope,
        {
            type: 'fact',
            content: `${presetId} memory`
        },
        [`${presetId}-speaker`]
    )
    await repository.upsertSnapshot(scope, `${presetId} query`, [])
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
        await repository.createJob(
            { conversationId: 'vector-index', presetId: '*' },
            'index',
            'rebuild'
        )

        assert.deepEqual((await repository.listDistinctPresetIds()).sort(), [
            'preset-clear',
            'preset-keep'
        ])

        await repository.clearAllByPreset('preset-clear')

        const targetCounts = await Promise.all([
            ctx.database.get('living_memory_entry', {
                presetId: 'preset-clear'
            }),
            ctx.database.get('living_memory_entry_speaker', {
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
            ctx.database.get('living_memory_entry_speaker', {
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

it('folds empty conversation keys to null and preserves real keys', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const manual = await repository.createMemory(
            { conversationId: '', presetId: 'preset-scope' },
            { type: 'fact', content: 'manual memory' }
        )
        assert.equal(manual.sourceConversationId, null)

        const grouped = await repository.createMemory(
            { conversationId: 'group:10001', presetId: 'preset-scope' },
            { type: 'fact', content: 'group memory' }
        )
        assert.equal(grouped.sourceConversationId, 'group:10001')
    })
})

it('migrates legacy webui conversation keys to null once', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        const grouped = await repository.createMemory(
            { conversationId: 'group:10001', presetId: 'preset-scope' },
            { type: 'fact', content: 'group memory' }
        )
        // 直接改库模拟历史版本 WebUI 手工创建写入的 webui: 占位键。
        await ctx.database.set(
            'living_memory_entry',
            { id: grouped.id },
            {
                sourceConversationId: 'webui:preset-scope'
            }
        )

        assert.equal(await repository.migrateWebuiSourceConversationKeys(), 1)

        const [row] = await ctx.database.get('living_memory_entry', {
            id: grouped.id
        })
        assert.equal(row.sourceConversationId, null)

        // 幂等：迁移记录落库后不再重复写回。
        assert.equal(await repository.migrateWebuiSourceConversationKeys(), 0)
    })
})
