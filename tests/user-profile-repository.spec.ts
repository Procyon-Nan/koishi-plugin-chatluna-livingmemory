import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils'

it('replaces preset speakers and deduplicates user profiles', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        await repository.upsertPresetSpeaker({
            presetId: ' preset-1 ',
            speakerKey: ' speaker-1 ',
            speakerLabel: '旧标签',
            speakerId: ' user-1 '
        })
        await repository.upsertPresetSpeaker({
            presetId: 'preset-1',
            speakerKey: 'speaker-1',
            speakerLabel: '新标签',
            speakerId: 'user-2'
        })

        const speakers = await repository.listPresetSpeakers('preset-1')
        assert.equal(speakers.length, 1)
        assert.equal(speakers[0].speakerLabel, '新标签')
        assert.equal(speakers[0].speakerId, 'user-2')

        await ctx.database.create('living_memory_user_profile', {
            id: 'profile-old',
            presetId: 'preset-1',
            speakerKey: 'speaker-1',
            speakerLabel: '旧标签',
            content: '旧画像一',
            sourceMemoryIds: ['memory-old-1'],
            createdAt: new Date('2026-07-14T00:00:00.000Z'),
            updatedAt: new Date('2026-07-14T00:00:00.000Z')
        })
        await ctx.database.create('living_memory_user_profile', {
            id: 'profile-stale',
            presetId: 'preset-1',
            speakerKey: 'speaker-1',
            speakerLabel: '旧标签',
            content: '旧画像二',
            sourceMemoryIds: ['memory-old-2'],
            createdAt: new Date('2026-07-14T01:00:00.000Z'),
            updatedAt: new Date('2026-07-14T01:00:00.000Z')
        })

        await repository.replaceUserProfile('preset-1', {
            speakerKey: 'speaker-1',
            speakerLabel: '新标签',
            content: '新画像',
            sourceMemoryIds: ['memory-new']
        })

        const profiles = await repository.listUserProfilesByPreset('preset-1')
        assert.equal(profiles.length, 1)
        assert.equal(profiles[0].id, 'profile-old')
        assert.equal(profiles[0].speakerLabel, '新标签')
        assert.equal(profiles[0].content, '新画像')
        assert.deepEqual(profiles[0].sourceMemoryIds, ['memory-new'])
    })
})
