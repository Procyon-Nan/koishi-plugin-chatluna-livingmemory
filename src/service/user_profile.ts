import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    LivingMemoryTranscriptMessage,
    UserProfileRecord
} from '../contracts/memory'
import type {
    DreamMemoryEntryRecord,
    LivingMemoryConfig,
    UserProfileRepository
} from '../contracts/workflows'
import { resolveAssistantLabel, resolvePresetPrompt } from './memory/helpers'
import {
    buildUserProfilePrompt,
    createUserProfileResultSchema,
    userProfileResultToolDescription,
    userProfileResultToolName
} from './prompts'
import { summarizeError } from './shared/utils'
import { invokeStructuredOutput } from './workflows/structured_output'
import type { LivingMemoryLogger } from './logging/logger'

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
    entries: DreamMemoryEntryRecord[]
    matchedEntryCount: number
    existingProfile?: UserProfileRecord
}

const normalizeText = (value: string) => value.replace(/\s+/gu, ' ').trim()
const normalizeSearchText = (value: string) =>
    normalizeText(value).toLowerCase()

const unique = <T>(items: T[]) => Array.from(new Set(items))

const truncateText = (value: string, maxLength: number) => {
    const chars = Array.from(value)
    if (chars.length <= maxLength) {
        return value
    }

    const suffix = '...'
    const contentLength = Math.max(0, maxLength - suffix.length)
    return `${chars.slice(0, contentLength).join('')}${suffix.slice(0, maxLength)}`
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
        private readonly logger: LivingMemoryLogger
    ) {}

    async regenerate(
        presetId: string,
        activeEntries: DreamMemoryEntryRecord[],
        model: ChatLunaChatModel,
        logger?: LivingMemoryLogger
    ): Promise<UserProfileGenerationResult> {
        const runLogger = logger ?? this.logger
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
        const assistantLabel = resolveAssistantLabel(presetId)
        const presetPrompt = await resolvePresetPrompt(this.ctx, presetId)
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
                assistantLabel,
                presetPrompt,
                group,
                maxProfileLength
            })
            let structuredResult
            try {
                structuredResult = await invokeStructuredOutput({
                    model,
                    prompt,
                    toolName: userProfileResultToolName,
                    toolDescription: userProfileResultToolDescription,
                    schema: createUserProfileResultSchema({
                        speakerLabel: group.speakerLabel,
                        allowedSourceMemoryIds:
                            this.getProfileFallbackSourceMemoryIds(group)
                    }),
                    stringifiedArrayField: 'profiles',
                    context: {
                        presetId,
                        conversationId: [
                            'user-profile',
                            presetId,
                            group.speakerKey
                        ].join(':')
                    },
                    logging:
                        logger == null
                            ? undefined
                            : {
                                  logger,
                                  workflow: 'dream',
                                  stage: 'user-profile',
                                  fields: {
                                      speaker: group.speakerLabel,
                                      speakerKey: group.speakerKey
                                  }
                              }
                })
            } catch (error) {
                failed++
                runLogger.diagnostic('user-profile.skipped', {
                    workflow: 'dream',
                    presetId,
                    speaker: group.speakerLabel,
                    reason: 'invoke-failed',
                    error: summarizeError(error)
                })
                continue
            }

            if (structuredResult.parseError !== null) {
                failed++
                const parseError = structuredResult.parseError
                runLogger.diagnostic('user-profile.skipped', {
                    workflow: 'dream',
                    presetId,
                    speaker: group.speakerLabel,
                    reason: 'structured-output-failed',
                    error: parseError
                })
                continue
            }

            const parsedProfiles = structuredResult.value.profiles
            const parsed = parsedProfiles[0]
            if (parsed === undefined) {
                empty++
                runLogger.diagnostic('user-profile.skipped', {
                    workflow: 'dream',
                    presetId,
                    speaker: group.speakerLabel,
                    reason: 'empty-profiles'
                })
                continue
            }

            const content = this.normalizeProfileContent(
                group.speakerLabel,
                parsed.content
            )
            if (content.length === 0) {
                empty++
                runLogger.diagnostic('user-profile.skipped', {
                    workflow: 'dream',
                    presetId,
                    speaker: group.speakerLabel,
                    reason: 'empty-content'
                })
                continue
            }

            await this.repository.replaceUserProfile(presetId, {
                speakerKey: group.speakerKey,
                speakerLabel: group.speakerLabel,
                content,
                sourceMemoryIds: unique(parsed.sourceMemoryIds)
            })
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
        activeEntries: DreamMemoryEntryRecord[],
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
        entries: DreamMemoryEntryRecord[],
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
        entry: DreamMemoryEntryRecord,
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

    private latestTimestamp(entries: DreamMemoryEntryRecord[]) {
        return Math.max(...entries.map((entry) => +entry.updatedAt))
    }

    private normalizeProfileContent(speakerLabel: string, content: string) {
        return truncateText(
            this.stripGeneratedTitle(speakerLabel, normalizeText(content)),
            maxProfileLength
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
}
