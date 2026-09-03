import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    PresetSpeakerInput,
    PresetSpeakerRecord,
    UserProfileInput,
    UserProfileRecord
} from '../../contracts/memory'
import {
    createPresetSpeakerId,
    normalizeOptionalString,
    normalizePresetSpeakerRecord,
    normalizeUserProfileRecord
} from './normalizers'
import type { LivingMemoryTransact } from './types'

/** 规范行排在最前：createdAt 最早者胜，同刻按 id 定序保证结果稳定。 */
const compareProfilesByCanonicalOrder = (
    left: UserProfileRecord,
    right: UserProfileRecord
) => +left.createdAt - +right.createdAt || left.id.localeCompare(right.id)

export class LivingMemoryUserProfileRepository {
    constructor(
        private readonly ctx: Context,
        private readonly transact: LivingMemoryTransact
    ) {}

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
        await this.transact(async (database) => {
            const existing = (
                await database.get('living_memory_preset_speaker', { id })
            )[0]

            if (existing == null) {
                await database.create('living_memory_preset_speaker', {
                    ...record,
                    id,
                    createdAt: now
                })
                return
            }

            await database.set('living_memory_preset_speaker', { id }, record)
        })
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

        // 同一 speakerKey 可能残留重复行，规范行的口径必须与
        // replaceUserProfile 的写入目标一致，否则读到的画像不是最后写入的那行。
        return profiles
            .map(normalizeUserProfileRecord)
            .sort(compareProfilesByCanonicalOrder)
    }

    async replaceUserProfile(presetId: string, profile: UserProfileInput) {
        await this.transact(async (database) => {
            const existing = (
                await database.get('living_memory_user_profile', {
                    presetId,
                    speakerKey: profile.speakerKey
                })
            )
                .map(normalizeUserProfileRecord)
                .sort(compareProfilesByCanonicalOrder)
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
                await database.create('living_memory_user_profile', {
                    ...record,
                    id: randomUUID(),
                    createdAt: now
                })
                return
            }

            await database.set(
                'living_memory_user_profile',
                { id: current.id },
                record
            )

            const staleIds = existing.slice(1).map((stale) => stale.id)
            if (staleIds.length > 0) {
                await database.remove('living_memory_user_profile', {
                    id: {
                        $in: staleIds
                    }
                })
            }
        })
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
