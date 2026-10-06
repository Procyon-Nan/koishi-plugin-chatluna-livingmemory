import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    LivingMemoryTranscriptMessage,
    PresetPersonaResolver,
    UserProfileRecord
} from '../contracts/memory'
import type {
    DreamMemoryEntryRecord,
    LivingMemoryConfig,
    UserProfileMemoryRepository,
    UserProfileRepository
} from '../contracts/workflows'
import { resolveAssistantLabel } from './memory/helpers'
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

type UserProfileMemoryGroup = Pick<
    UserProfileGroup,
    'speakerKey' | 'entries' | 'matchedEntryCount'
>

/** 送入画像的记忆优先级：重要度降序，同重要度取更新更晚者。 */
const compareEntriesByProfilePriority = (
    left: DreamMemoryEntryRecord,
    right: DreamMemoryEntryRecord
) =>
    (right.importance ?? 0.5) - (left.importance ?? 0.5) ||
    +right.updatedAt - +left.updatedAt

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
        private readonly config: LivingMemoryUserProfileConfig,
        private readonly repository: UserProfileRepository &
            UserProfileMemoryRepository,
        private readonly logger: LivingMemoryLogger,
        private readonly presetPersona: PresetPersonaResolver
    ) {}

    /**
     * 画像阶段是否会执行。调用方据此决定是否准备画像输入，避免各自解读配置项。
     */
    get enabled() {
        return this.config.enableUserProfileInjection
    }

    async regenerate(
        presetId: string,
        speakerKeys: string[],
        model: ChatLunaChatModel,
        logger?: LivingMemoryLogger
    ): Promise<UserProfileGenerationResult> {
        const runLogger = logger ?? this.logger
        if (!this.enabled) {
            return {
                generated: 0,
                skippedReason: 'disabled',
                detail: 'user profiles skipped: disabled'
            }
        }

        const memoryGroups = await this.loadEligibleMemoryGroups(
            presetId,
            normalizeSpeakerKeys(speakerKeys)
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
        const pendingGroups = profileGroups.filter(
            (group) => !this.isProfileUpToDate(group)
        )
        if (pendingGroups.length === 0) {
            return {
                generated: 0,
                skippedReason: 'unchanged',
                detail:
                    'user profiles skipped: unchanged ' +
                    `matched=${profileGroups.length}`
            }
        }

        const assistantLabel = resolveAssistantLabel(presetId)
        const presetPrompt = await this.presetPersona.resolve(presetId)
        const matchedEntryCount = profileGroups.reduce(
            (sum, group) => sum + group.matchedEntryCount,
            0
        )
        const selectedEntryCount = profileGroups.reduce(
            (sum, group) => sum + group.entries.length,
            0
        )
        let generated = 0
        let kept = 0
        let failed = 0

        for (const group of pendingGroups) {
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
            } else if (outcome === 'kept') {
                kept++
            } else {
                failed++
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
                `unchanged=${profileGroups.length - pendingGroups.length}`,
                `kept=${kept}`,
                `failed=${failed}`
            ].join(' ')
        }
    }

    /**
     * 取出达到最低记忆数量的用户及其活跃记忆。门槛只按实际读取到的活跃记忆数
     * 判定：关联索引与记忆读取是两次查询，索引行可能指向期间已归档或已删除的
     * 记忆，索引行数不能代表送入模型的记忆条数。
     */
    private async loadEligibleMemoryGroups(
        presetId: string,
        speakerKeys: string[]
    ): Promise<UserProfileMemoryGroup[]> {
        const links = await this.repository.listActiveMemorySpeakerLinks(
            presetId,
            speakerKeys
        )
        const activeEntryById = new Map(
            (
                await this.repository.getEntriesByPresetAndIds(presetId, [
                    ...new Set(links.map((link) => link.memoryId))
                ])
            )
                .filter((entry) => entry.status === 'active')
                .map((entry) => [entry.id, entry])
        )
        const entriesBySpeakerKey = new Map<string, DreamMemoryEntryRecord[]>()
        for (const link of links) {
            const entry = activeEntryById.get(link.memoryId)
            if (entry?.speakerKeys.includes(link.speakerKey) !== true) {
                continue
            }

            const entries = entriesBySpeakerKey.get(link.speakerKey)
            if (entries == null) {
                entriesBySpeakerKey.set(link.speakerKey, [entry])
            } else {
                entries.push(entry)
            }
        }

        return [...entriesBySpeakerKey]
            .filter(
                ([, entries]) =>
                    entries.length >= this.config.userProfileMinMemoryCount
            )
            .map(([speakerKey, entries]) => ({
                speakerKey,
                entries: entries
                    .sort(compareEntriesByProfilePriority)
                    .slice(0, this.config.userProfileMemoryLimit),
                matchedEntryCount: entries.length
            }))
            .sort(
                (left, right) =>
                    right.matchedEntryCount - left.matchedEntryCount ||
                    this.latestTimestamp(right.entries) -
                        this.latestTimestamp(left.entries)
            )
    }

    private latestTimestamp(entries: DreamMemoryEntryRecord[]) {
        return Math.max(...entries.map((entry) => +entry.updatedAt))
    }

    /**
     * 画像输入是否与上次审阅时相同（改写或 keep 都会记下本次输入）。判据为
     * 选中记忆集合未变，且画像审阅时刻严格晚于组内全部记忆的更新时刻；同刻按
     * 已变化处理。相同输入的模型调用是确定的空操作，跳过它不改变结果。
     *
     * 判据不覆盖 prompt 侧变化：模型输入还包含 assistantLabel 与 presetPrompt，
     * 改预设人设或升级画像模板都不会被判为需要重算。这类重算由既有的删除画像
     * 通道兜底——画像删除后 existingProfile 为空，下一次 Dream 必然重建。
     */
    private isProfileUpToDate(group: UserProfileGroup) {
        const existingProfile = group.existingProfile
        if (existingProfile == null) {
            return false
        }

        const sourceMemoryIds = new Set(existingProfile.sourceMemoryIds)
        return (
            sourceMemoryIds.size === group.entries.length &&
            group.entries.every((entry) => sourceMemoryIds.has(entry.id)) &&
            +existingProfile.updatedAt > this.latestTimestamp(group.entries)
        )
    }

    /**
     * 生成并写入单个说话者的画像。返回结果区分：generated 表示已改写画像，
     * kept 表示模型判断已有画像无需变更、只记下本次审阅的输入，failed 表示
     * 模型调用或结构化校验失败并已通过 logProfileSkipped 记录。
     */
    private async generateProfileForGroup(
        presetId: string,
        group: UserProfileGroup,
        model: ChatLunaChatModel,
        assistantLabel: string,
        presetPrompt: string,
        logger: LivingMemoryLogger | undefined,
        runLogger: LivingMemoryLogger
    ): Promise<'generated' | 'kept' | 'failed'> {
        let structuredResult
        try {
            const prompt = buildUserProfilePrompt({
                assistantLabel,
                presetPrompt,
                group
            })
            structuredResult = await invokeStructuredOutput({
                model,
                prompt,
                toolName: userProfileResultToolName,
                toolDescription:
                    '提交当前用户画像的处理结果：需要生成或更新时用 update 提交完整画像，已有画像无需变更时用 keep 保留；两者都须说明理由。',
                schema: userProfileResultSchema,
                validateResult: ({ decision }) => {
                    if (
                        decision.action === 'keep' &&
                        group.existingProfile == null
                    ) {
                        throw new Error(
                            '当前尚无人物画像，不能使用 keep，必须使用 update 生成画像'
                        )
                    }
                },
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

        const decision = structuredResult.value.decision
        const sourceMemoryIds = group.entries.map((entry) => entry.id)
        if (decision.action === 'keep') {
            // validateResult 已拒绝无画像时的 keep。记下本次输入，同一组记忆
            // 下次被 isProfileUpToDate 判为最新，不再重复询问模型。
            await this.repository.markUserProfileReviewed(
                group.existingProfile!.id,
                sourceMemoryIds
            )
            runLogger.diagnostic('user-profile.kept', {
                workflow: 'dream',
                presetId,
                speaker: group.speakerLabel
            })
            return 'kept'
        }

        await this.repository.replaceUserProfile(presetId, {
            speakerKey: group.speakerKey,
            speakerLabel: group.speakerLabel,
            content: decision.content.replace(/\s+/gu, ' '),
            sourceMemoryIds
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
        if (!this.enabled) {
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
