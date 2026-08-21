import type { Context } from 'koishi'
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

type LivingMemoryDatabase = Context['database']

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
    database: LivingMemoryDatabase,
    table: 'living_memory_user_profile' | 'living_memory_preset_speaker',
    ids: string[]
) => {
    if (ids.length > 0) {
        await database.remove(table, { id: { $in: ids } })
    }
}

export const reconcilePresetSpeaker = async (
    database: LivingMemoryDatabase,
    input: PresetSpeakerInput
) => {
    const identity = {
        presetId: input.presetId.trim(),
        speakerKey: input.speakerKey.trim(),
        speakerLabel: normalizeUserProfileSpeakerLabel(input.speakerLabel),
        speakerId: normalizeOptionalString(input.speakerId),
        platform: normalizeOptionalString(input.platform)
    }
    if (
        identity.presetId.length === 0 ||
        identity.speakerKey.length === 0 ||
        identity.speakerLabel.length === 0 ||
        identity.speakerId == null ||
        identity.platform == null
    ) {
        return
    }

    await database.withTransaction(async (transaction) => {
        const stableId = createPresetSpeakerId(
            identity.presetId,
            identity.speakerKey
        )
        const rows = [
            ...(await transaction.get('living_memory_preset_speaker', {
                presetId: identity.presetId,
                speakerId: identity.speakerId
            })),
            ...(await transaction.get('living_memory_preset_speaker', {
                id: stableId
            }))
        ]
        const speakers = [...new Map(rows.map((row) => [row.id, row])).values()]
            .map(normalizePresetSpeakerRecord)
            .filter(
                (speaker) =>
                    speaker.speakerKey === identity.speakerKey ||
                    (speaker.speakerId === identity.speakerId &&
                        (speaker.platform == null ||
                            speaker.platform === identity.platform))
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
            await transaction.get('living_memory_user_profile', {
                presetId: identity.presetId,
                speakerKey: { $in: [...candidateKeys] }
            })
        )
            .map(normalizeUserProfileRecord)
            .sort(compareProfilesByFreshness)
        const currentProfile = profiles[0]
        if (currentProfile != null) {
            await transaction.set(
                'living_memory_user_profile',
                { id: currentProfile.id },
                {
                    presetId: identity.presetId,
                    speakerKey: identity.speakerKey,
                    speakerLabel: identity.speakerLabel,
                    content: currentProfile.content,
                    sourceMemoryIds: [
                        ...new Set(
                            profiles.flatMap(
                                (profile) => profile.sourceMemoryIds
                            )
                        )
                    ],
                    updatedAt: currentProfile.updatedAt
                }
            )
            await removeByIds(
                transaction,
                'living_memory_user_profile',
                profiles.slice(1).map((profile) => profile.id)
            )
        }

        const now = new Date()
        await transaction.upsert('living_memory_preset_speaker', [
            {
                id: stableId,
                ...identity,
                speakerAliases: aliases,
                createdAt: earliestCreatedAt(speakers, now),
                updatedAt: now
            }
        ])
        await removeByIds(
            transaction,
            'living_memory_preset_speaker',
            speakers
                .filter((speaker) => speaker.id !== stableId)
                .map((speaker) => speaker.id)
        )
    })
}
