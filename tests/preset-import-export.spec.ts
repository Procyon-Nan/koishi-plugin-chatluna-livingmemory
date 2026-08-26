import assert from 'node:assert/strict'
import { withLivingMemoryRepository } from './persistence-test-utils'
import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetExportEntry
} from '../src/contracts/memory'
import { createPresetImportId } from '../src/service/persistence/normalizers'

const createExportEntry = (
    id: string,
    index: number
): LivingMemoryPresetExportEntry => ({
    id,
    type: 'fact',
    status: 'active',
    content: `memory-${index}`,
    keywords: [`keyword-${index}`],
    summary: null,
    sentiment: null,
    importance: null,
    sourceConversationId: `conversation-${index}`,
    sourceOrigins: [],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z'
})

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
        await repository.setMemoryConsolidation(
            sourcePresetId,
            [sourceMemory.id],
            true
        )

        const exported = await repository.exportPresetData(sourcePresetId)
        if (exported.version !== 2) {
            throw new Error('expected version 2 preset export')
        }
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
        assert.equal(importedTargetMemories[0].isConsolidated, false)

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

it('preserves consolidation only for same-preset version 2 restores', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const presetId = 'preset-consolidation'
        const memory = await repository.createMemory(
            { conversationId: 'conversation-1', presetId },
            { type: 'fact', content: 'consolidated memory' }
        )
        await repository.setMemoryConsolidation(presetId, [memory.id], true)
        const exported = await repository.exportPresetData(presetId)
        if (exported.version !== 2) {
            throw new Error('expected version 2 preset export')
        }

        assert.equal(exported.entries[0].isConsolidated, true)
        await repository.setMemoryConsolidation(presetId, [memory.id], false)
        await repository.importPresetData(presetId, exported)

        assert.equal(
            (await repository.getEntryById(memory.id))?.isConsolidated,
            true
        )
    })
})

it('normalizes missing version 1 consolidation state to pending', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const targetPresetId = 'version-1-target'
        const data: LivingMemoryPresetExport = {
            version: 1,
            exportedAt: '2026-08-06T00:00:00.000Z',
            sourcePresetId: targetPresetId,
            entries: [createExportEntry('version-1-entry', 1)],
            userProfiles: [],
            presetSpeakers: []
        }

        await repository.importPresetData(targetPresetId, data)

        assert.equal(
            (await repository.listEntriesByPreset(targetPresetId))[0]
                .isConsolidated,
            false
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

it('imports large preset exports in bounded batches', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const targetPresetId = 'large-import-target'
        const entries = Array.from({ length: 1001 }, (_, index) =>
            createExportEntry(index.toString(16).padStart(64, '0'), index)
        )
        const data: LivingMemoryPresetExport = {
            version: 1,
            exportedAt: '2026-08-06T00:00:00.000Z',
            sourcePresetId: 'large-import-source',
            entries,
            userProfiles: Array.from({ length: 101 }, (_, index) => ({
                id: `profile-${index}`,
                speakerKey: `speaker-${index}`,
                speakerLabel: `Speaker ${index}`,
                content: `profile-${index}`,
                sourceMemoryIds: [entries[index].id],
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:00.000Z'
            })),
            presetSpeakers: Array.from({ length: 101 }, (_, index) => ({
                speakerKey: `speaker-${index}`,
                speakerLabel: `Speaker ${index}`,
                speakerId: null,
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:00.000Z'
            }))
        }

        const result = await repository.importPresetData(targetPresetId, data)

        assert.deepEqual(result, {
            entries: 1001,
            userProfiles: 101,
            presetSpeakers: 101
        })
        assert.equal(
            (await repository.listEntriesByPreset(targetPresetId)).length,
            1001
        )
        const profiles =
            await repository.listUserProfilesByPreset(targetPresetId)
        assert.equal(profiles.length, 101)
        const firstProfile = profiles.find(
            (profile) => profile.speakerKey === 'speaker-0'
        )
        assert.ok(firstProfile)
        assert.deepEqual(firstProfile.sourceMemoryIds, [
            createPresetImportId('entry', targetPresetId, entries[0].id)
        ])
        assert.equal(
            (await repository.listPresetSpeakers(targetPresetId)).length,
            101
        )
        assert.deepEqual(await repository.listJobsByPreset(targetPresetId), [])
    })
})

it('rolls back all batches when a later import batch fails', async () => {
    await withLivingMemoryRepository(async (_ctx, repository) => {
        const targetPresetId = 'rollback-import-target'
        const entries = Array.from({ length: 102 }, (_, index) => {
            const id =
                index < 100
                    ? index.toString(16).padStart(64, '0')
                    : 'f'.repeat(64)
            return createExportEntry(id, index)
        })
        const data: LivingMemoryPresetExport = {
            version: 1,
            exportedAt: '2026-08-06T00:00:00.000Z',
            sourcePresetId: 'rollback-import-source',
            entries,
            userProfiles: [],
            presetSpeakers: []
        }

        await assert.rejects(
            repository.importPresetData(targetPresetId, data),
            /preset import failed during entries batch 2\/2/
        )
        assert.deepEqual(
            await repository.listEntriesByPreset(targetPresetId),
            []
        )

        const created = await repository.createMemory(
            {
                conversationId: 'rollback-health-check',
                presetId: targetPresetId
            },
            {
                type: 'fact',
                content: 'database remains writable after rollback'
            }
        )
        assert.equal(
            created.content,
            'database remains writable after rollback'
        )
    })
})
