import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils'

it('copies preset data without moving source records', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const sourcePresetId = 'preset-source'
        const targetPresetId = 'preset-target'
        const sourceMemory = await repository.createMemory(
            {
                conversationId: 'conversation-source',
                presetId: sourcePresetId
            },
            {
                type: 'fact',
                content: 'source memory'
            }
        )
        await repository.replaceUserProfile(sourcePresetId, {
            speakerKey: 'speaker-key',
            speakerLabel: 'Speaker',
            content: 'source profile',
            sourceMemoryIds: [sourceMemory.id]
        })
        await repository.upsertPresetSpeaker({
            presetId: sourcePresetId,
            speakerKey: 'speaker-key',
            speakerLabel: 'Speaker'
        })

        const exported = await repository.exportPresetData(sourcePresetId)
        const sourceProfile = exported.userProfiles[0]

        await repository.importPresetData(targetPresetId, exported)

        const retainedSourceMemories =
            await repository.listEntriesByPreset(sourcePresetId)
        const importedTargetMemories =
            await repository.listEntriesByPreset(targetPresetId)
        assert.deepEqual(
            retainedSourceMemories.map((entry) => entry.id),
            [sourceMemory.id]
        )
        assert.equal(importedTargetMemories.length, 1)
        assert.notEqual(importedTargetMemories[0].id, sourceMemory.id)
        assert.equal(importedTargetMemories[0].content, sourceMemory.content)

        const retainedSourceProfiles =
            await repository.listUserProfilesByPreset(sourcePresetId)
        const importedTargetProfiles =
            await repository.listUserProfilesByPreset(targetPresetId)
        assert.deepEqual(
            retainedSourceProfiles.map((profile) => profile.id),
            [sourceProfile.id]
        )
        assert.equal(importedTargetProfiles.length, 1)
        assert.notEqual(importedTargetProfiles[0].id, sourceProfile.id)
        assert.deepEqual(importedTargetProfiles[0].sourceMemoryIds, [
            importedTargetMemories[0].id
        ])

        assert.equal(
            (await repository.listPresetSpeakers(sourcePresetId)).length,
            1
        )
        assert.equal(
            (await repository.listPresetSpeakers(targetPresetId)).length,
            1
        )

        await repository.importPresetData(targetPresetId, exported)
        assert.deepEqual(
            (await repository.listEntriesByPreset(targetPresetId)).map(
                (entry) => entry.id
            ),
            [importedTargetMemories[0].id]
        )
        assert.deepEqual(
            (await repository.listUserProfilesByPreset(targetPresetId)).map(
                (profile) => profile.id
            ),
            [importedTargetProfiles[0].id]
        )
    })
})

it('preserves record ids when restoring the source preset', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const presetId = 'preset-restore'
        const memory = await repository.createMemory(
            {
                conversationId: 'conversation-restore',
                presetId
            },
            {
                type: 'fact',
                content: 'original memory'
            }
        )
        const exported = await repository.exportPresetData(presetId)

        await repository.updateMemory(memory.id, {
            content: 'changed memory'
        })
        await repository.importPresetData(presetId, exported)

        const restored = await repository.listEntriesByPreset(presetId)
        assert.equal(restored.length, 1)
        assert.equal(restored[0].id, memory.id)
        assert.equal(restored[0].content, 'original memory')
    })
})
