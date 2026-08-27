import assert from 'node:assert/strict'
import { createUserProfileSpeakerKey } from '../src/service/memory/speaker_identity'
import { withLivingMemoryRepository } from './persistence-test-utils'

it('reconciles nickname-based profiles into one stable user identity', async () => {
    await withLivingMemoryRepository(async (ctx, repository) => {
        for (const speakerLabel of ['旧昵称', '新昵称']) {
            await repository.upsertPresetSpeaker({
                presetId: 'preset-1',
                speakerKey: speakerLabel,
                speakerLabel,
                speakerId: 'user-1'
            })
        }

        await ctx.database.create('living_memory_user_profile', {
            id: 'profile-old',
            presetId: 'preset-1',
            speakerKey: '旧昵称',
            speakerLabel: '旧昵称',
            content: '旧画像',
            sourceMemoryIds: ['memory-old'],
            createdAt: new Date('2026-07-14T00:00:00.000Z'),
            updatedAt: new Date('2026-07-14T00:00:00.000Z')
        })
        await ctx.database.create('living_memory_user_profile', {
            id: 'profile-newer',
            presetId: 'preset-1',
            speakerKey: '新昵称',
            speakerLabel: '新昵称',
            content: '较新的画像',
            sourceMemoryIds: ['memory-new', 'memory-old'],
            createdAt: new Date('2026-07-15T00:00:00.000Z'),
            updatedAt: new Date('2026-07-15T00:00:00.000Z')
        })

        const stableKey = createUserProfileSpeakerKey('onebot', 'user-1')
        await repository.reconcilePresetSpeaker({
            presetId: 'preset-1',
            speakerKey: stableKey,
            speakerLabel: '当前昵称',
            speakerId: 'user-1',
            platform: 'onebot'
        })

        const speakers = await repository.listPresetSpeakers('preset-1')
        assert.equal(speakers.length, 1)
        assert.equal(speakers[0].speakerKey, stableKey)
        assert.equal(speakers[0].speakerLabel, '当前昵称')
        assert.equal(speakers[0].speakerId, 'user-1')
        assert.equal(speakers[0].platform, 'onebot')
        assert.deepEqual(speakers[0].speakerAliases, [
            '旧昵称',
            '新昵称',
            '当前昵称'
        ])

        const profiles = await repository.listUserProfilesByPreset('preset-1')
        assert.equal(profiles.length, 1)
        assert.equal(profiles[0].id, 'profile-newer')
        assert.equal(profiles[0].speakerKey, stableKey)
        assert.equal(profiles[0].speakerLabel, '当前昵称')
        assert.equal(profiles[0].content, '较新的画像')
        assert.deepEqual(profiles[0].sourceMemoryIds, [
            'memory-new',
            'memory-old'
        ])

        await repository.reconcilePresetSpeaker({
            presetId: 'preset-1',
            speakerKey: stableKey,
            speakerLabel: '再次改名',
            speakerId: 'user-1',
            platform: 'onebot'
        })
        const renamedProfiles =
            await repository.listUserProfilesByPreset('preset-1')
        assert.equal(renamedProfiles.length, 1)
        assert.equal(renamedProfiles[0].id, 'profile-newer')
        assert.equal(renamedProfiles[0].speakerLabel, '再次改名')
        assert.deepEqual(
            (await repository.listPresetSpeakers('preset-1'))[0].speakerAliases,
            ['旧昵称', '新昵称', '当前昵称', '再次改名']
        )

        await repository.updateUserProfileContent(
            renamedProfiles[0].id,
            '手工编辑后的画像'
        )
        const edited = await repository.listUserProfilesByPreset('preset-1')
        assert.equal(edited[0].content, '手工编辑后的画像')
        assert.deepEqual(edited[0].sourceMemoryIds, [
            'memory-new',
            'memory-old'
        ])

        await repository.replaceUserProfile('preset-1', {
            speakerKey: stableKey,
            speakerLabel: '再次改名',
            content: 'Dream 重新生成的画像',
            sourceMemoryIds: ['memory-dream']
        })
        const regenerated =
            await repository.listUserProfilesByPreset('preset-1')
        assert.equal(regenerated[0].content, 'Dream 重新生成的画像')
        assert.deepEqual(regenerated[0].sourceMemoryIds, ['memory-dream'])
    })
})

it('keeps users with the same nickname separate by stable identity', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        for (const speakerId of ['user-1', 'user-2']) {
            await repository.reconcilePresetSpeaker({
                presetId: 'preset-1',
                speakerKey: createUserProfileSpeakerKey('onebot', speakerId),
                speakerLabel: '相同昵称',
                speakerId,
                platform: 'onebot'
            })
        }

        const speakers = await repository.listPresetSpeakers('preset-1')
        assert.equal(speakers.length, 2)
        assert.notEqual(speakers[0].speakerKey, speakers[1].speakerKey)
    })
})
