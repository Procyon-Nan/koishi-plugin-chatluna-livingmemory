import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    LivingMemoryTranscriptMessage,
    PresetSpeakerRecord,
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

export const userProfileMaxLength = 220

export const normalizeManualUserProfileContent = (content: string) => {
    const normalized = content.trim()
    const length = Array.from(normalized).length
    if (length === 0 || length > userProfileMaxLength) {
        throw new RangeError(
            `用户画像正文长度必须为 1-${userProfileMaxLength} 个字符。`
        )
    }
    return normalized
}

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

const collapseWhitespace = (value: string) => value.replace(/\s+/gu, ' ').trim()

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

export const collectUserProfileSpeakerKeys = (
    messages: LivingMemoryTranscriptMessage[]
) => {
    const keys: string[] = []
    const seen = new Set<string>()

    for (const message of messages) {
        if (message.role !== 'user') {
            continue
        }

        const key = message.speakerKey?.trim()
        if (key == null || key.length === 0 || seen.has(key)) {
            continue
        }

        seen.add(key)
        keys.push(key)
    }

    return keys
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
            const outcome = await this.generateProfileForGroup(
                presetId,
                group,
                model,
                assistantLabel,
                presetPrompt,
                logger,
                runLogger
            )
            if (outcome === 'generated') {
                generated++
            } else if (outcome === 'failed') {
                failed++
            } else {
                empty++
            }
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

    /**
     * 生成并写入单个说话者的画像。返回结果区分：generated 表示已写入，
     * failed 表示模型调用或结构化校验失败，empty 表示产出为空；
     * 后两类跳过原因均已通过 logProfileSkipped 记录。
     */
    private async generateProfileForGroup(
        presetId: string,
        group: UserProfileGroup,
        model: ChatLunaChatModel,
        assistantLabel: string,
        presetPrompt: string,
        logger: LivingMemoryLogger | undefined,
        runLogger: LivingMemoryLogger
    ): Promise<'generated' | 'failed' | 'empty'> {
        const prompt = buildUserProfilePrompt({
            assistantLabel,
            presetPrompt,
            group,
            maxProfileLength: userProfileMaxLength
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
            this.logProfileSkipped(runLogger, {
                presetId,
                speaker: group.speakerLabel,
                reason: 'invoke-failed',
                error: summarizeError(error)
            })
            return 'failed'
        }

        if (structuredResult.parseError !== null) {
            this.logProfileSkipped(runLogger, {
                presetId,
                speaker: group.speakerLabel,
                reason: 'structured-output-failed',
                error: structuredResult.parseError
            })
            return 'failed'
        }

        const parsed = structuredResult.value.profiles[0]
        if (parsed === undefined) {
            this.logProfileSkipped(runLogger, {
                presetId,
                speaker: group.speakerLabel,
                reason: 'empty-profiles'
            })
            return 'empty'
        }

        const content = this.normalizeProfileContent(
            group.speakerLabel,
            parsed.content
        )
        if (content.length === 0) {
            this.logProfileSkipped(runLogger, {
                presetId,
                speaker: group.speakerLabel,
                reason: 'empty-content'
            })
            return 'empty'
        }

        await this.repository.replaceUserProfile(presetId, {
            speakerKey: group.speakerKey,
            speakerLabel: group.speakerLabel,
            content,
            sourceMemoryIds: unique(parsed.sourceMemoryIds)
        })
        return 'generated'
    }

    private logProfileSkipped(
        logger: LivingMemoryLogger,
        fields: {
            presetId: string
            speaker: string
            reason: string
            error?: string
        }
    ) {
        logger.diagnostic('user-profile.skipped', {
            workflow: 'dream',
            ...fields
        })
    }

    async renderForSpeakers(presetId: string, speakerKeys: string[]) {
        if (!this.config.enableUserProfileInjection) {
            return ''
        }

        const orderedKeys = this.toOrderedSpeakerKeys(speakerKeys)
        if (orderedKeys.length === 0) {
            return ''
        }

        const profiles = await this.repository.listUserProfilesBySpeakerKeys(
            presetId,
            orderedKeys
        )
        const profileByKey = new Map(
            profiles.map((profile) => [profile.speakerKey, profile])
        )

        return orderedKeys
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
        speakers: PresetSpeakerRecord[]
    ): UserProfileGroup[] {
        return speakers
            .filter(
                (speaker) =>
                    speaker.speakerId != null && speaker.platform != null
            )
            .map((speaker) => {
                const entries = this.selectEntriesForSpeaker(
                    activeEntries,
                    speaker.speakerKey
                )

                return {
                    speakerKey: speaker.speakerKey,
                    speakerLabel: speaker.speakerLabel,
                    entries: entries.slice(
                        0,
                        this.config.userProfileMemoryLimit
                    ),
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
        speakerKey: string
    ) {
        return entries
            .filter((entry) => entry.speakerKeys.includes(speakerKey))
            .sort((left, right) => {
                const importanceDelta =
                    (right.importance ?? 0.5) - (left.importance ?? 0.5)
                if (importanceDelta !== 0) {
                    return importanceDelta
                }

                return +right.updatedAt - +left.updatedAt
            })
    }

    private latestTimestamp(entries: DreamMemoryEntryRecord[]) {
        return Math.max(...entries.map((entry) => +entry.updatedAt))
    }

    private normalizeProfileContent(speakerLabel: string, content: string) {
        return truncateText(
            this.stripGeneratedTitle(speakerLabel, collapseWhitespace(content)),
            userProfileMaxLength
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

    private toOrderedSpeakerKeys(speakerKeys: string[]) {
        const keys: string[] = []
        const seen = new Set<string>()

        for (const speakerKey of speakerKeys) {
            const key = speakerKey.trim()
            if (key.length === 0 || seen.has(key)) {
                continue
            }

            seen.add(key)
            keys.push(key)
        }

        return keys
    }
}
