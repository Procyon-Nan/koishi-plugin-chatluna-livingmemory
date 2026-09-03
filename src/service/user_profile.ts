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
    userProfileResultSchema,
    userProfileResultToolName
} from './prompts'
import { summarizeError } from './shared/utils'
import { invokeStructuredOutput } from './workflows/structured_output'
import type { LivingMemoryLogger } from './logging/logger'
import { normalizeSpeakerKeys } from './memory/speaker_identity'

export const normalizeManualUserProfileContent = (content: string) => {
    const normalized = content.trim()
    if (normalized.length === 0) {
        throw new RangeError('用户画像正文不能为空。')
    }
    return normalized
}

type LivingMemoryUserProfileConfig = Pick<
    LivingMemoryConfig,
    | 'enableUserProfileInjection'
    | 'userProfileMinMemoryCount'
    | 'userProfileMemoryLimit'
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
        speakerKeys: string[],
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

        const requestedSpeakerKeys = normalizeSpeakerKeys(speakerKeys)
        const links = await this.repository.listActiveMemorySpeakerLinks(
            presetId,
            requestedSpeakerKeys
        )
        const memoryIdsBySpeakerKey = new Map<string, string[]>()
        for (const link of links) {
            const memoryIds = memoryIdsBySpeakerKey.get(link.speakerKey)
            if (memoryIds == null) {
                memoryIdsBySpeakerKey.set(link.speakerKey, [link.memoryId])
            } else {
                memoryIds.push(link.memoryId)
            }
        }
        const eligibleMemoryGroups = [...memoryIdsBySpeakerKey].filter(
            ([, memoryIds]) =>
                memoryIds.length >= this.config.userProfileMinMemoryCount
        )
        const memoryIds = [
            ...new Set(
                eligibleMemoryGroups.flatMap(([, relatedIds]) => relatedIds)
            )
        ]
        const activeEntryById = new Map(
            (
                await this.repository.getEntriesByPresetAndIds(
                    presetId,
                    memoryIds
                )
            )
                .filter((entry) => entry.status === 'active')
                .map((entry) => [entry.id, entry])
        )
        const memoryGroups = eligibleMemoryGroups
            .flatMap(([speakerKey, relatedIds]) => {
                const entries = relatedIds.flatMap((memoryId) => {
                    const entry = activeEntryById.get(memoryId)
                    return entry?.speakerKeys.includes(speakerKey) === true
                        ? [entry]
                        : []
                })
                if (entries.length < this.config.userProfileMinMemoryCount) {
                    return []
                }

                return [
                    {
                        speakerKey,
                        entries: entries
                            .sort((left, right) => {
                                const importanceDelta =
                                    (right.importance ?? 0.5) -
                                    (left.importance ?? 0.5)
                                return (
                                    importanceDelta ||
                                    +right.updatedAt - +left.updatedAt
                                )
                            })
                            .slice(0, this.config.userProfileMemoryLimit),
                        matchedEntryCount: entries.length
                    }
                ]
            })
            .sort(
                (left, right) =>
                    right.matchedEntryCount - left.matchedEntryCount ||
                    Math.max(
                        ...right.entries.map((entry) => +entry.updatedAt)
                    ) -
                        Math.max(
                            ...left.entries.map((entry) => +entry.updatedAt)
                        )
            )
        if (memoryGroups.length === 0) {
            return {
                generated: 0,
                skippedReason: 'insufficient-related-memories',
                detail:
                    'user profiles skipped: insufficient-related-memories ' +
                    `minimum=${this.config.userProfileMinMemoryCount}`
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

        const speakerByKey = new Map(
            speakers
                .filter(
                    (speaker) =>
                        speaker.speakerId != null && speaker.platform != null
                )
                .map((speaker) => [speaker.speakerKey, speaker] as const)
        )
        const profileGroups: UserProfileGroup[] = []
        for (const group of memoryGroups) {
            const speaker = speakerByKey.get(group.speakerKey)
            if (speaker != null) {
                profileGroups.push({
                    ...group,
                    speakerLabel: speaker.speakerLabel
                })
            }
        }
        if (profileGroups.length === 0) {
            return {
                generated: 0,
                skippedReason: 'no-user-speakers',
                detail: 'user profiles skipped: no-user-speakers'
            }
        }

        const existingProfiles =
            await this.repository.listUserProfilesBySpeakerKeys(
                presetId,
                profileGroups.map((group) => group.speakerKey)
            )
        // 仓储按规范行顺序返回，重复行下首个即 replaceUserProfile 的写入目标，
        // 因此这里取首次出现者，保证读到的画像与写入的是同一行。
        const existingProfileByKey = new Map<string, UserProfileRecord>()
        for (const profile of existingProfiles) {
            if (!existingProfileByKey.has(profile.speakerKey)) {
                existingProfileByKey.set(profile.speakerKey, profile)
            }
        }
        for (const group of profileGroups) {
            group.existingProfile = existingProfileByKey.get(group.speakerKey)
        }
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
                `minimumMemories=${this.config.userProfileMinMemoryCount}`,
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
            group
        })
        let structuredResult
        try {
            structuredResult = await invokeStructuredOutput({
                model,
                prompt,
                toolName: userProfileResultToolName,
                toolDescription:
                    '提交当前用户画像的更新结果。无需更新时将 content 设为 null。',
                schema: userProfileResultSchema,
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

        const profileContent = structuredResult.value.content
        if (profileContent === null) {
            this.logProfileSkipped(runLogger, {
                presetId,
                speaker: group.speakerLabel,
                reason: 'empty-content'
            })
            return 'empty'
        }

        const content = profileContent.replace(/\s+/gu, ' ').trim()
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
            sourceMemoryIds: group.entries.map((entry) => entry.id)
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
                    `${profile.speakerLabel}的人物画像：\n${profile.content}`
            )
            .join('\n\n')
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
