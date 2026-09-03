import type {
    PresetSpeakerInput,
    PresetSpeakerRecord,
    UserProfileRecord
} from '../../contracts/memory'
import {
    normalizeUserProfileSpeakerAliasKey,
    normalizeUserProfileSpeakerLabel
} from '../memory/speaker_identity'
import {
    createPresetSpeakerId,
    normalizeOptionalString,
    normalizePresetSpeakerRecord,
    normalizeUserProfileRecord
} from './normalizers'
import type { LivingMemoryTransaction } from './types'

const uniqueAliases = (aliases: string[]) => {
    const result: string[] = []
    const seen = new Set<string>()
    for (const alias of aliases) {
        const normalized = normalizeUserProfileSpeakerLabel(alias)
        const key = normalizeUserProfileSpeakerAliasKey(normalized)
        if (normalized.length > 0 && !seen.has(key)) {
            seen.add(key)
            result.push(normalized)
        }
    }
    return result
}

const compareProfilesByFreshness = (
    left: UserProfileRecord,
    right: UserProfileRecord
) => +right.updatedAt - +left.updatedAt || left.id.localeCompare(right.id)

const earliestCreatedAt = (speakers: PresetSpeakerRecord[], fallback: Date) =>
    speakers.reduce(
        (earliest, speaker) =>
            +speaker.createdAt < +earliest ? speaker.createdAt : earliest,
        fallback
    )

const removeByIds = async (
    database: LivingMemoryTransaction,
    table: 'living_memory_user_profile' | 'living_memory_preset_speaker',
    ids: string[]
) => {
    if (ids.length > 0) {
        await database.remove(table, { id: { $in: ids } })
    }
}

export interface PresetSpeakerIdentity {
    presetId: string
    speakerKey: string
    speakerLabel: string
    speakerId: string
    platform: string
}

/**
 * 归一化并校验稳定身份。缺少任一必要字段时返回 `null`，由调用方据此完全跳过
 * 协调，避免为无效输入开启事务。
 */
export const resolvePresetSpeakerIdentity = (
    input: PresetSpeakerInput
): PresetSpeakerIdentity | null => {
    const presetId = input.presetId.trim()
    const speakerKey = input.speakerKey.trim()
    const speakerLabel = normalizeUserProfileSpeakerLabel(input.speakerLabel)
    const speakerId = normalizeOptionalString(input.speakerId)
    const platform = normalizeOptionalString(input.platform)
    if (
        presetId.length === 0 ||
        speakerKey.length === 0 ||
        speakerLabel.length === 0 ||
        speakerId == null ||
        platform == null
    ) {
        return null
    }
    return { presetId, speakerKey, speakerLabel, speakerId, platform }
}

export const reconcilePresetSpeaker = async (
    database: LivingMemoryTransaction,
    identity: PresetSpeakerIdentity
) => {
    const { speakerId, platform } = identity

    const stableId = createPresetSpeakerId(
        identity.presetId,
        identity.speakerKey
    )
    const rows = [
        ...(await database.get('living_memory_preset_speaker', {
            presetId: identity.presetId,
            speakerId
        })),
        ...(await database.get('living_memory_preset_speaker', {
            id: stableId
        }))
    ]
    const speakers = [...new Map(rows.map((row) => [row.id, row])).values()]
        .map(normalizePresetSpeakerRecord)
        .filter(
            (speaker) =>
                speaker.speakerKey === identity.speakerKey ||
                (speaker.speakerId === speakerId &&
                    (speaker.platform == null ||
                        speaker.platform === platform))
        )
    const aliases = uniqueAliases([
        ...speakers.flatMap((speaker) => [
            ...speaker.speakerAliases,
            speaker.speakerLabel
        ]),
        identity.speakerLabel
    ])
    const candidateKeys = new Set([
        identity.speakerKey,
        ...speakers.map((speaker) => speaker.speakerKey),
        ...speakers.flatMap((speaker) =>
            speaker.speakerAliases.map(normalizeUserProfileSpeakerAliasKey)
        )
    ])
    const profiles = (
        await database.get('living_memory_user_profile', {
            presetId: identity.presetId,
            speakerKey: { $in: [...candidateKeys] }
        })
    )
        .map(normalizeUserProfileRecord)
        .sort(compareProfilesByFreshness)
    const currentProfile = profiles[0]
    if (currentProfile != null) {
        await database.set(
            'living_memory_user_profile',
            { id: currentProfile.id },
            {
                presetId: identity.presetId,
                speakerKey: identity.speakerKey,
                speakerLabel: identity.speakerLabel,
                content: currentProfile.content,
                sourceMemoryIds: [
                    ...new Set(
                        profiles.flatMap((profile) => profile.sourceMemoryIds)
                    )
                ],
                updatedAt: currentProfile.updatedAt
            }
        )
        await removeByIds(
            database,
            'living_memory_user_profile',
            profiles.slice(1).map((profile) => profile.id)
        )
    }

    const now = new Date()
    await database.upsert('living_memory_preset_speaker', [
        {
            id: stableId,
            ...identity,
            speakerAliases: aliases,
            createdAt: earliestCreatedAt(speakers, now),
            updatedAt: now
        }
    ])
    await removeByIds(
        database,
        'living_memory_preset_speaker',
        speakers
            .filter((speaker) => speaker.id !== stableId)
            .map((speaker) => speaker.id)
    )
}
