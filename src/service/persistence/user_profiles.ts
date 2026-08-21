import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    PresetSpeakerInput,
    PresetSpeakerRecord,
    UserProfileInput,
    UserProfileRecord
} from '../../contracts/memory'
import type { UserProfileRepository } from '../../contracts/workflows'
import {
    createPresetSpeakerId,
    normalizeOptionalString,
    normalizePresetSpeakerRecord,
    normalizeUserProfileRecord
} from './normalizers'

export class LivingMemoryUserProfileRepository implements UserProfileRepository {
    constructor(private readonly ctx: Context) {}

    async listPresetSpeakers(presetId: string): Promise<PresetSpeakerRecord[]> {
        const speakers = await this.ctx.database.get(
            'living_memory_preset_speaker',
            { presetId }
        )

        return speakers
            .map(normalizePresetSpeakerRecord)
            .filter(
                (speaker) =>
                    speaker.speakerKey.length > 0 &&
                    speaker.speakerLabel.length > 0
            )
            .sort((left, right) =>
                left.speakerLabel.localeCompare(right.speakerLabel)
            )
    }

    async upsertPresetSpeaker(input: PresetSpeakerInput) {
        const presetId = input.presetId.trim()
        const speakerKey = input.speakerKey.trim()
        const speakerLabel = input.speakerLabel.trim()
        if (
            presetId.length === 0 ||
            speakerKey.length === 0 ||
            speakerLabel.length === 0
        ) {
            return
        }

        const now = new Date()
        const id = createPresetSpeakerId(presetId, speakerKey)
        const record = {
            presetId,
            speakerKey,
            speakerLabel,
            speakerAliases: [speakerLabel],
            speakerId: normalizeOptionalString(input.speakerId),
            platform: normalizeOptionalString(input.platform),
            updatedAt: now
        }
        const existing = (
            await this.ctx.database.get('living_memory_preset_speaker', { id })
        )[0]

        if (existing == null) {
            await this.ctx.database.create('living_memory_preset_speaker', {
                ...record,
                id,
                createdAt: now
            })
            return
        }

        await this.ctx.database.set(
            'living_memory_preset_speaker',
            { id },
            record
        )
    }

    async listUserProfilesByPreset(
        presetId: string
    ): Promise<UserProfileRecord[]> {
        const profiles = await this.ctx.database.get(
            'living_memory_user_profile',
            { presetId }
        )

        return profiles
            .map(normalizeUserProfileRecord)
            .sort((left, right) =>
                left.speakerLabel.localeCompare(right.speakerLabel)
            )
    }

    async listUserProfilesBySpeakerKeys(
        presetId: string,
        speakerKeys: string[]
    ): Promise<UserProfileRecord[]> {
        const keys = [...new Set(speakerKeys)].filter((key) => key.length > 0)
        if (keys.length === 0) {
            return []
        }

        const profiles = await this.ctx.database.get(
            'living_memory_user_profile',
            {
                presetId,
                speakerKey: {
                    $in: keys
                }
            }
        )

        return profiles.map(normalizeUserProfileRecord)
    }

    async replaceUserProfile(presetId: string, profile: UserProfileInput) {
        const existing = (
            await this.ctx.database.get('living_memory_user_profile', {
                presetId,
                speakerKey: profile.speakerKey
            })
        )
            .map(normalizeUserProfileRecord)
            .sort((left, right) => +left.createdAt - +right.createdAt)
        const current = existing[0]
        const now = new Date()
        const record = {
            presetId,
            speakerKey: profile.speakerKey,
            speakerLabel: profile.speakerLabel,
            content: profile.content,
            sourceMemoryIds: profile.sourceMemoryIds,
            updatedAt: now
        }

        if (current == null) {
            await this.ctx.database.create('living_memory_user_profile', {
                ...record,
                id: randomUUID(),
                createdAt: now
            })
            return
        }

        await this.ctx.database.set(
            'living_memory_user_profile',
            { id: current.id },
            record
        )

        const staleIds = existing.slice(1).map((profile) => profile.id)
        if (staleIds.length > 0) {
            await this.ctx.database.remove('living_memory_user_profile', {
                id: {
                    $in: staleIds
                }
            })
        }
    }

    async updateUserProfileContent(profileId: string, content: string) {
        await this.ctx.database.set(
            'living_memory_user_profile',
            { id: profileId },
            { content, updatedAt: new Date() }
        )
    }

    async deleteUserProfile(profileId: string) {
        await this.ctx.database.remove('living_memory_user_profile', {
            id: profileId
        })
    }
}
