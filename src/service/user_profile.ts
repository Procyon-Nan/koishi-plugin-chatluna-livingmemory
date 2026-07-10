import { Context } from 'koishi'
import type {
    LivingMemoryConfig,
    LivingMemoryTranscriptMessage,
    MemoryEntryRecord,
    UserProfileInput,
    UserProfileRecord,
    UserProfileRepository
} from '../types'
import {
    type CharacterPresetProvider,
    characterPresetSuffix,
    renderCharacterPresetPrompt,
    renderChatLunaPresetPrompt
} from './memory/helpers'
import { buildUserProfilePrompt } from './prompts'
import { summarizeError } from './shared/utils'

const maxProfileLength = 220

type LivingMemoryUserProfileConfig = Pick<
    LivingMemoryConfig,
    'enableUserProfileInjection' | 'userProfileMemoryLimit'
>

export interface UserProfileGenerationResult {
    generated: number
    detail: string
    skippedReason?: string
}

interface UserProfileGroup {
    speakerKey: string
    speakerLabel: string
    entries: MemoryEntryRecord[]
    matchedEntryCount: number
    existingProfile?: UserProfileRecord
}

const normalizeText = (value: string) => value.replace(/\s+/gu, ' ').trim()
const normalizeSearchText = (value: string) =>
    normalizeText(value).toLowerCase()

const unique = <T>(items: T[]) => Array.from(new Set(items))

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

const toCharacterPresetName = (presetId: string) => {
    return presetId.endsWith(characterPresetSuffix)
        ? presetId.slice(0, -characterPresetSuffix.length)
        : null
}

const truncateText = (value: string, maxLength: number) => {
    const chars = Array.from(value)
    if (chars.length <= maxLength) {
        return value
    }

    return `${chars.slice(0, maxLength).join('')}...`
}

export const normalizeUserProfileSpeakerKey = (speakerLabel: string) => {
    return normalizeText(speakerLabel).toLowerCase()
}

export const normalizeUserProfileSpeakerLabel = normalizeText

export const collectUserProfileSpeakerLabels = (
    messages: LivingMemoryTranscriptMessage[]
) => {
    const labels: string[] = []
    const seen = new Set<string>()

    for (const message of messages) {
        if (message.role !== 'user') {
            continue
        }

        const label = normalizeText(message.speakerLabel)
        const key = normalizeUserProfileSpeakerKey(label)
        if (label.length === 0 || key.length === 0 || seen.has(key)) {
            continue
        }

        seen.add(key)
        labels.push(label)
    }

    return labels
}

export class LivingMemoryUserProfileService {
    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryUserProfileConfig,
        private readonly repository: UserProfileRepository,
        private readonly debug: (message: string) => void
    ) {}

    async regenerate(
        presetId: string,
        activeEntries: MemoryEntryRecord[],
        invokeModel: (prompt: string) => Promise<string>
    ): Promise<UserProfileGenerationResult> {
        if (!this.config.enableUserProfileInjection) {
            return {
                generated: 0,
                skippedReason: 'disabled',
                detail: 'user profiles skipped: disabled'
            }
        }

        const speakers = await this.repository.listPresetSpeakers(presetId)
        if (speakers.length === 0) {
            return {
                generated: 0,
                skippedReason: 'no-user-speakers',
                detail: 'user profiles skipped: no-user-speakers'
            }
        }

        const groups = this.buildGroups(activeEntries, speakers)
        if (groups.length === 0) {
            return {
                generated: 0,
                skippedReason: 'no-related-memories',
                detail: `user profiles skipped: no-related-memories speakers=${speakers.length}`
            }
        }

        const existingProfiles =
            await this.repository.listUserProfilesByPreset(presetId)
        const existingProfileByKey = new Map(
            existingProfiles.map((profile) => [profile.speakerKey, profile])
        )
        const profileGroups: UserProfileGroup[] = groups.map((group) => ({
            ...group,
            existingProfile: existingProfileByKey.get(group.speakerKey)
        }))
        const presetPrompt = await this.resolvePresetPrompt(presetId)
        const matchedEntryCount = profileGroups.reduce(
            (sum, group) => sum + group.matchedEntryCount,
            0
        )
        const selectedEntryCount = profileGroups.reduce(
            (sum, group) => sum + group.entries.length,
            0
        )
        let generated = 0
        let failed = 0
        let empty = 0

        for (const group of profileGroups) {
            const prompt = buildUserProfilePrompt({
                presetId,
                presetPrompt,
                group,
                maxProfileLength
            })
            this.debug(
                [
                    `memory user profile llm prompt: presetId=${presetId}`,
                    `speaker=${group.speakerLabel}`,
                    prompt
                ].join('\n')
            )

            let output: string
            try {
                output = await invokeModel(prompt)
            } catch (error) {
                failed++
                this.debug(
                    [
                        `memory user profile skipped: presetId=${presetId}`,
                        `speaker=${group.speakerLabel}`,
                        'reason=invoke-failed',
                        `error=${summarizeError(error)}`
                    ].join(' ')
                )
                continue
            }

            this.debug(
                [
                    `memory user profile llm output: presetId=${presetId}`,
                    `speaker=${group.speakerLabel}`,
                    output
                ].join('\n')
            )

            const parsed = this.parseProfiles(output, [group])
            if (parsed.parseError != null) {
                failed++
                this.debug(
                    [
                        `memory user profile skipped: presetId=${presetId}`,
                        `speaker=${group.speakerLabel}`,
                        `reason=parse-failed error=${parsed.parseError}`
                    ].join(' ')
                )
                continue
            }

            const profile = parsed.profiles[0]
            if (profile == null) {
                empty++
                continue
            }

            await this.repository.replaceUserProfile(presetId, profile)
            generated++
        }

        return {
            generated,
            skippedReason: generated === 0 ? 'no-valid-profiles' : undefined,
            detail: [
                `user profiles generated: ${generated}`,
                `speakers=${speakers.length}`,
                `matched=${profileGroups.length}`,
                `matchedMemories=${matchedEntryCount}`,
                `selectedMemories=${selectedEntryCount}`,
                `skippedNoRelated=${speakers.length - profileGroups.length}`,
                `empty=${empty}`,
                `failed=${failed}`
            ].join(' ')
        }
    }

    async renderForSpeakers(presetId: string, speakerLabels: string[]) {
        if (!this.config.enableUserProfileInjection) {
            return ''
        }

        const speakerKeys = this.toOrderedSpeakerKeys(speakerLabels)
        if (speakerKeys.length === 0) {
            return ''
        }

        const profiles = await this.repository.listUserProfilesBySpeakerKeys(
            presetId,
            speakerKeys
        )
        const profileByKey = new Map(
            profiles.map((profile) => [profile.speakerKey, profile])
        )

        return speakerKeys
            .map((key) => profileByKey.get(key))
            .filter((profile): profile is NonNullable<typeof profile> => {
                return profile != null && profile.content.trim().length > 0
            })
            .map(
                (profile) =>
                    `${profile.speakerLabel}的个人画像：\n${profile.content}`
            )
            .join('\n\n')
    }

    private buildGroups(
        activeEntries: MemoryEntryRecord[],
        speakers: { speakerKey: string; speakerLabel: string }[]
    ): UserProfileGroup[] {
        return speakers
            .map((speaker) => {
                const entries = this.selectEntriesForSpeaker(
                    activeEntries,
                    speaker.speakerLabel
                )

                return {
                    speakerKey: speaker.speakerKey,
                    speakerLabel: speaker.speakerLabel,
                    entries: entries.slice(0, this.getProfileMemoryLimit()),
                    matchedEntryCount: entries.length
                }
            })
            .filter((group) => group.entries.length > 0)
            .sort((left, right) => {
                if (right.entries.length !== left.entries.length) {
                    return right.entries.length - left.entries.length
                }

                return (
                    this.latestTimestamp(right.entries) -
                    this.latestTimestamp(left.entries)
                )
            })
    }

    private selectEntriesForSpeaker(
        entries: MemoryEntryRecord[],
        speakerLabel: string
    ) {
        return entries
            .filter((entry) =>
                this.entryMatchesSpeakerKeyword(entry, speakerLabel)
            )
            .sort((left, right) => {
                const importanceDelta =
                    (right.importance ?? 0.5) - (left.importance ?? 0.5)
                if (importanceDelta !== 0) {
                    return importanceDelta
                }

                return +right.updatedAt - +left.updatedAt
            })
    }

    private getProfileMemoryLimit() {
        const configured = Math.floor(this.config.userProfileMemoryLimit)
        if (!Number.isFinite(configured)) {
            return 20
        }

        return Math.min(100, Math.max(5, configured))
    }

    private entryMatchesSpeakerKeyword(
        entry: MemoryEntryRecord,
        speakerLabel: string
    ) {
        const needle = normalizeSearchText(speakerLabel)
        if (needle.length === 0) {
            return false
        }

        const searchable = [
            entry.content,
            entry.summary ?? '',
            entry.keywords.join('\n')
        ]
            .map(normalizeSearchText)
            .join('\n')

        return searchable.includes(needle)
    }

    private latestTimestamp(entries: MemoryEntryRecord[]) {
        return Math.max(...entries.map((entry) => +entry.updatedAt))
    }

    private parseProfiles(
        output: string,
        groups: UserProfileGroup[]
    ): { profiles: UserProfileInput[]; parseError: string | null } {
        const normalized = output.trim()
        const firstBracket = normalized.indexOf('[')
        const lastBracket = normalized.lastIndexOf(']')
        if (firstBracket < 0 || lastBracket < firstBracket) {
            return {
                profiles: [],
                parseError: 'no JSON array delimiters found'
            }
        }

        let parsed: unknown
        try {
            parsed = JSON.parse(normalized.slice(firstBracket, lastBracket + 1))
        } catch (error) {
            return { profiles: [], parseError: summarizeError(error) }
        }

        if (!Array.isArray(parsed)) {
            return { profiles: [], parseError: 'parsed value is not an array' }
        }

        const groupByKey = new Map(
            groups.map((group) => [group.speakerKey, group])
        )
        const profiles = parsed
            .map((item) => this.toUserProfileInput(item, groupByKey))
            .filter((profile): profile is UserProfileInput => profile != null)

        return { profiles, parseError: null }
    }

    private toUserProfileInput(
        item: unknown,
        groupByKey: Map<string, UserProfileGroup>
    ): UserProfileInput | null {
        if (!isRecord(item)) {
            return null
        }
        if (
            typeof item.speakerLabel !== 'string' ||
            typeof item.content !== 'string'
        ) {
            return null
        }

        const speakerKey = normalizeUserProfileSpeakerKey(item.speakerLabel)
        const group = groupByKey.get(speakerKey)
        if (group == null) {
            return null
        }

        const content = this.normalizeProfileContent(
            group.speakerLabel,
            item.content
        )
        if (content.length === 0) {
            return null
        }

        return {
            speakerKey: group.speakerKey,
            speakerLabel: group.speakerLabel,
            content,
            sourceMemoryIds: this.resolveProfileSourceMemoryIds(
                item.sourceMemoryIds,
                group
            )
        }
    }

    private normalizeProfileContent(speakerLabel: string, content: string) {
        return truncateText(
            this.stripGeneratedTitle(speakerLabel, normalizeText(content)),
            maxProfileLength
        )
    }

    private resolveProfileSourceMemoryIds(
        sourceMemoryIds: unknown,
        group: UserProfileGroup
    ) {
        const fallbackIds = this.getProfileFallbackSourceMemoryIds(group)
        const candidateIds = Array.isArray(sourceMemoryIds)
            ? sourceMemoryIds
            : fallbackIds
        const allowedIds = new Set(fallbackIds)

        return unique(
            candidateIds.filter((id): id is string => {
                return typeof id === 'string' && allowedIds.has(id)
            })
        )
    }

    private getProfileFallbackSourceMemoryIds(group: UserProfileGroup) {
        return [
            ...(group.existingProfile?.sourceMemoryIds ?? []),
            ...group.entries.map((entry) => entry.id)
        ]
    }

    private stripGeneratedTitle(speakerLabel: string, content: string) {
        const title = `${speakerLabel}的个人画像`
        if (content === title) {
            return ''
        }
        if (
            content.startsWith(`${title}:`) ||
            content.startsWith(`${title}：`)
        ) {
            return content.slice(title.length + 1).trim()
        }

        return content
    }

    private toOrderedSpeakerKeys(speakerLabels: string[]) {
        const keys: string[] = []
        const seen = new Set<string>()

        for (const label of speakerLabels) {
            const key = normalizeUserProfileSpeakerKey(label)
            if (key.length === 0 || seen.has(key)) {
                continue
            }

            seen.add(key)
            keys.push(key)
        }

        return keys
    }

    private async resolvePresetPrompt(presetId: string) {
        const characterPresetName = toCharacterPresetName(presetId)
        if (characterPresetName != null) {
            return await this.resolveCharacterPresetPrompt(
                presetId,
                characterPresetName
            )
        }

        return await this.resolveChatLunaPresetPrompt(presetId)
    }

    private async resolveChatLunaPresetPrompt(presetId: string) {
        try {
            const preset = this.ctx.chatluna.preset.getPreset(
                presetId,
                false
            ).value
            if (preset == null) {
                return null
            }

            return await renderChatLunaPresetPrompt(this.ctx, preset)
        } catch (error) {
            this.debug(
                [
                    `memory user profile preset prompt skipped: presetId=${presetId}`,
                    'source=chatluna',
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
            return null
        }
    }

    private async resolveCharacterPresetPrompt(
        presetId: string,
        presetName: string
    ) {
        const character = (
            this.ctx as Context & {
                chatluna_character?: CharacterPresetProvider
            }
        ).chatluna_character
        const presetProvider = character?.preset
        if (presetProvider?.getPreset == null) {
            this.debug(
                [
                    `memory user profile preset prompt skipped: presetId=${presetId}`,
                    'source=character',
                    'reason=character-preset-unavailable'
                ].join(' ')
            )
            return null
        }

        try {
            const preset = await presetProvider.getPreset(presetName, false)
            const prompt = await renderCharacterPresetPrompt(this.ctx, preset)
            if (prompt == null) {
                this.debug(
                    [
                        `memory user profile preset prompt skipped: presetId=${presetId}`,
                        'source=character',
                        `presetName=${presetName}`,
                        'reason=empty-system-prompt'
                    ].join(' ')
                )
                return null
            }

            return prompt
        } catch (error) {
            this.debug(
                [
                    `memory user profile preset prompt skipped: presetId=${presetId}`,
                    'source=character',
                    `presetName=${presetName}`,
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
            return null
        }
    }
}
