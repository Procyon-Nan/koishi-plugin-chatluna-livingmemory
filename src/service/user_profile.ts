import { isRequestFailure } from 'koishi-plugin-chatluna/utils/error'
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
import { userProfileResultTool } from './prompts/memory_tools'
import { buildUserProfilePrompts } from './prompts/user_profile'
import { invokeStructuredOutput } from './workflows/structured_output'
import { formatLogScope, type LivingMemoryLogger } from './logging/logger'
import { normalizeSpeakerKeys } from './memory/speaker_identity'
import { SerialTaskQueue } from './shared/serial_task_queue'

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
    return [
        ...new Set(
            messages
                .filter((message) => message.role === 'user')
                .map((message) => message.speakerKey?.trim())
                .filter((key): key is string => Boolean(key))
        )
    ]
}

export class LivingMemoryUserProfileService {
    private readonly queue = new SerialTaskQueue()
    private readonly controller = new AbortController()
    private readonly tasks = new Set<Promise<UserProfileGenerationResult>>()

    constructor(
        private readonly config: LivingMemoryUserProfileConfig,
        private readonly repository: UserProfileRepository &
            UserProfileMemoryRepository,
        private readonly logger: LivingMemoryLogger,
        private readonly presetPersona: PresetPersonaResolver,
        private readonly createModel: () => Promise<ChatLunaChatModel>
    ) {}

    async regenerate(
        presetId: string,
        speakerKeys?: string[],
        options: { force?: boolean } = {}
    ): Promise<UserProfileGenerationResult> {
        this.controller.signal.throwIfAborted()
        const task = this.queue.run(presetId, async () => {
            const signal = this.controller.signal
            signal.throwIfAborted()
            this.logger.diagnosticSummary(() => ({
                event: '人物画像生成开始',
                detail: `预设：${presetId}`
            }))
            const result = await this.generate(
                presetId,
                speakerKeys,
                signal,
                options.force === true
            )
            this.logger.diagnosticSummary(() => ({
                event: '人物画像生成结束',
                detail: `预设：${presetId}; ${result.detail}`
            }))
            return result
        })
        this.tasks.add(task)
        try {
            return await task
        } finally {
            this.tasks.delete(task)
        }
    }

    queueGeneration(presetId: string, speakerKeys?: string[]) {
        void this.regenerate(presetId, speakerKeys).catch((error) => {
            this.logger.summary(
                '人物画像生成失败',
                `预设：${presetId}`,
                'error',
                error
            )
        })
    }

    async stop() {
        this.controller.abort(new Error('人物画像服务正在停止。'))
        await Promise.allSettled([...this.tasks])
    }

    private async generate(
        presetId: string,
        speakerKeys: string[] | undefined,
        signal: AbortSignal,
        force: boolean
    ): Promise<UserProfileGenerationResult> {
        const runLogger = this.logger.with({ workflow: 'user-profile', presetId })
        const speakers = await this.repository.listPresetSpeakers(presetId)
        const memoryGroups = await this.loadEligibleMemoryGroups(
            presetId,
            normalizeSpeakerKeys(
                speakerKeys ?? speakers.map((speaker) => speaker.speakerKey)
            )
        )
        if (memoryGroups.length === 0) {
            return {
                generated: 0,
                detail: `关联记忆尚未达到门槛：每人 ${this.config.userProfileMinMemoryCount} 条`
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
                detail: '符合条件的用户：0 人'
            }
        }

        const existingProfiles =
            await this.repository.listUserProfilesBySpeakerKeys(
                presetId,
                profileGroups.map((group) => group.speakerKey)
            )
        // 逆序写入 Map，使仓储返回的首行与 replaceUserProfile 的写入目标一致。
        const existingProfileByKey = new Map(
            existingProfiles
                .reverse()
                .map((profile) => [profile.speakerKey, profile])
        )
        for (const group of profileGroups) {
            group.existingProfile = existingProfileByKey.get(group.speakerKey)
        }
        const pendingGroups = profileGroups.filter(
            (group) => force || !this.isProfileUpToDate(group)
        )
        if (pendingGroups.length === 0) {
            return {
                generated: 0,
                detail: `画像已是最新：${profileGroups.length} 人`
            }
        }

        const assistantLabel = resolveAssistantLabel(presetId)
        const model = await this.createModel()
        signal.throwIfAborted()
        const presetPrompt =
            await this.presetPersona.resolveOrGenerateCardText(presetId)
        const matchedEntryCount = profileGroups.reduce(
            (sum, group) => sum + group.matchedEntryCount,
            0
        )
        const selectedEntryCount = profileGroups.reduce(
            (sum, group) => sum + group.entries.length,
            0
        )
        const counts = { generated: 0, kept: 0, failed: 0 }

        for (const group of pendingGroups) {
            signal.throwIfAborted()
            const outcome = await this.generateProfileForGroup(
                presetId,
                group,
                model,
                assistantLabel,
                presetPrompt,
                runLogger.with({
                    speaker: group.speakerLabel,
                    speakerKey: group.speakerKey
                }),
                signal
            )
            counts[outcome]++
        }

        return {
            generated: counts.generated,
            detail: [
                `更新画像：${counts.generated} 人`,
                `预设用户：${speakers.length} 人`,
                `符合条件：${profileGroups.length} 人`,
                `关联记忆：${matchedEntryCount} 条`,
                `选用记忆：${selectedEntryCount} 条`,
                `每人最低记忆数：${this.config.userProfileMinMemoryCount} 条`,
                `已是最新：${profileGroups.length - pendingGroups.length} 人`,
                `保持原样：${counts.kept} 人`,
                `失败：${counts.failed} 人`
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

    /** 按上次审阅的记忆集合与更新时间跳过相同输入；WebUI 重新生成直接略过此判断。 */
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
     * 模型调用或结构化校验失败时记录该用户的失败原因。
     */
    private async generateProfileForGroup(
        presetId: string,
        group: UserProfileGroup,
        model: ChatLunaChatModel,
        assistantLabel: string,
        presetPrompt: string,
        logger: LivingMemoryLogger,
        signal: AbortSignal
    ): Promise<'generated' | 'kept' | 'failed'> {
        const prompt = buildUserProfilePrompts({
            assistantLabel,
            presetPrompt,
            group
        })
        let structuredResult
        try {
            structuredResult = await invokeStructuredOutput({
                model,
                signal,
                prompt,
                toolName: userProfileResultTool.name,
                toolDescription: userProfileResultTool.description,
                schema: userProfileResultTool.schema,
                validateResult: ({ action, content }) => {
                    if (action === 'update' && content === undefined) {
                        return 'action 为 update 时必须提交 content，填写完整的新人物画像正文'
                    }
                    if (action === 'keep' && group.existingProfile == null) {
                        return '当前尚无人物画像，不能使用 keep，必须使用 update 生成画像'
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
                logging: { logger, stage: 'user-profile' }
            })
        } catch (error) {
            signal.throwIfAborted()
            if (!isRequestFailure(error)) throw error
            logger.summary(
                '人物画像处理失败',
                (fields) =>
                    `${formatLogScope(fields)}; 人物：${group.speakerLabel}; 原因：模型调用失败`,
                'warn',
                error
            )
            return 'failed'
        }

        if (structuredResult.parseError !== null) {
            logger.summary(
                '人物画像处理失败',
                (fields) =>
                    `${formatLogScope(fields)}; 人物：${group.speakerLabel}; 原因：${structuredResult.parseError}`,
                'warn'
            )
            return 'failed'
        }

        signal.throwIfAborted()
        const decision = structuredResult.value
        const sourceMemoryIds = group.entries.map((entry) => entry.id)
        if (decision.action === 'keep') {
            // validateResult 已拒绝无画像时的 keep。记下本次输入，同一组记忆
            // 下次被 isProfileUpToDate 判为最新，不再重复询问模型。
            await this.repository.markUserProfileReviewed(
                group.existingProfile!.id,
                sourceMemoryIds
            )
            logger.diagnosticSummary((fields) => ({
                event: '人物画像保持原样',
                detail: `${formatLogScope(fields)}; 用户：${group.speakerLabel}; 原因：${decision.reason}`
            }))
            return 'kept'
        }

        await this.repository.replaceUserProfile(presetId, {
            speakerKey: group.speakerKey,
            speakerLabel: group.speakerLabel,
            content: decision.content!.replace(/\s+/gu, ' '),
            sourceMemoryIds
        })
        logger.diagnosticSummary((fields) => ({
            event: '人物画像已更新',
            detail: `${formatLogScope(fields)}; 用户：${group.speakerLabel}; 原因：${decision.reason}`
        }))
        return 'generated'
    }

    async renderForSpeakers(presetId: string, speakerKeys: string[]) {
        if (!this.config.enableUserProfileInjection) {
            return ''
        }

        const orderedKeys = [
            ...new Set(speakerKeys.map((key) => key.trim()).filter(Boolean))
        ]
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
}
