import { createHash } from 'crypto'
import type { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
    PresetPersonaCardInfo,
    PresetPersonaRecord,
    PresetPersonaResolver,
    PresetPersonaSource
} from '../../contracts/memory'
import type { LivingMemoryConfig } from '../../contracts/workflows'
import { summarizeError } from '../shared/utils'
import {
    buildPersonaCardPrompt,
    personaCardResultSchema,
    personaCardResultToolName
} from '../prompts'
import { invokeStructuredOutput } from '../workflows/structured_output'
import type { LivingMemoryLogger } from '../logging/logger'
import { SerialTaskQueue } from '../shared/serial_task_queue'
import { resolvePresetPrompt } from './helpers'

type PresetPersonaConfig = Pick<LivingMemoryConfig, 'mainModel'>

/** 删除比例超过该值即视为删减异常，回退原文。 */
const MAX_DELETION_RATIO = 0.8

/** 剪出的卡片短于该字符数即视为异常，回退原文。 */
const MIN_CARD_LENGTH = 20

interface PresetPersonaRepository {
    getPresetPersona(presetId: string): Promise<PresetPersonaRecord | undefined>
    listPresetPersonas(): Promise<PresetPersonaRecord[]>
    upsertPresetPersona(input: {
        presetId: string
        card: string
        rawHash: string
        source: PresetPersonaSource
        totalLines: number
        deletedLines: number
        usedRawFallback: boolean
    }): Promise<void>
    deletePresetPersona(presetId: string): Promise<void>
}

/** 提供当前预设 id 全集，用于判定卡片是否过期或预设已不存在。 */
interface PresetIdCatalog {
    list(): Promise<string[]>
}

/** 模型侧失败的原因；此类回退不落库，下次解析时重试。 */
type PersonaPruneFailure =
    | 'model-unavailable'
    | 'invoke-failed'
    | 'structured-output-failed'

interface PersonaCardOutcome {
    card: string
    totalLines: number
    deletedLines: number
    usedRawFallback: boolean
    failure: PersonaPruneFailure | null
}

/**
 * 预设人设卡片服务。把预设 system 部分原文按行删减掉纯操作性内容，供记忆
 * 提取、Dream 与用户画像注入；recall 不注入预设，不接入。
 *
 * 落库行（`living_memory_preset_persona`，主键 presetId）是卡片的唯一状态，
 * 本服务是它唯一的写入方。模型生成在写队列之外进行，落库在按 presetId 串行
 * 的写队列内重读行后提交：生成期间被手工保存的卡片不被覆盖，生成期间被清空
 * 的预设不被写回。
 */
export class LivingMemoryPresetPersonaService
    implements PresetPersonaResolver
{
    private readonly generating = new Map<string, Promise<string>>()
    private readonly writes = new SerialTaskQueue()
    private readonly clearEpochs = new Map<string, number>()

    constructor(
        private readonly ctx: Context,
        private readonly config: PresetPersonaConfig,
        private readonly repository: PresetPersonaRepository,
        private readonly logger: LivingMemoryLogger,
        private readonly catalog: PresetIdCatalog
    ) {}

    /**
     * 按预设 id 取卡片：手工卡片与原文哈希一致的自动卡片直接返回，否则生成
     * 并落库。同一预设的并发生成合并为一次。
     */
    async resolve(presetId: string): Promise<string> {
        const epoch = this.clearEpoch(presetId)
        const raw = await resolvePresetPrompt(this.ctx, presetId)
        const rawHash = hashPresetText(raw)
        const stored = await this.repository.getPresetPersona(presetId)
        if (
            stored != null &&
            (stored.source === 'manual' || stored.rawHash === rawHash)
        ) {
            return stored.card
        }

        const pending = this.generating.get(presetId)
        if (pending !== undefined) {
            return await pending
        }
        const task = this.generate(presetId, raw, rawHash, epoch)
        this.generating.set(presetId, task)
        try {
            return await task
        } finally {
            this.generating.delete(presetId)
        }
    }

    /**
     * 只读取卡片正文：已落库时返回卡片，否则返回预设原文。不调模型、不落库，
     * 供外部插件使用。
     */
    async readCard(presetId: string): Promise<string> {
        const stored = await this.repository.getPresetPersona(presetId)
        return stored?.card ?? (await resolvePresetPrompt(this.ctx, presetId))
    }

    /**
     * 列出全部已落库卡片及其异常提示，供 Console 展示与外部插件读取。只读：
     * 不调模型、不落库，未生成卡片的预设不会出现在结果里。
     */
    async listCards(): Promise<PresetPersonaCardInfo[]> {
        const [stored, presetIds] = await Promise.all([
            this.repository.listPresetPersonas(),
            this.catalog.list().catch(() => [])
        ])
        const available = new Set(presetIds)

        return await Promise.all(
            stored.map(async (record) =>
                toCardInfo(
                    record,
                    !available.has(record.presetId),
                    await this.isStale(record)
                )
            )
        )
    }

    /**
     * 读取单个已落库卡片；未生成时返回 undefined。不触发生成，只服务展示与
     * 外部读取。
     */
    async getCard(
        presetId: string
    ): Promise<PresetPersonaCardInfo | undefined> {
        const record = await this.repository.getPresetPersona(presetId)
        if (record == null) {
            return undefined
        }

        const presetIds = await this.catalog.list().catch(() => [])
        return toCardInfo(
            record,
            !presetIds.includes(record.presetId),
            await this.isStale(record)
        )
    }

    /**
     * 卡片是否已落后于当前预设原文。自动卡片由 `resolve` 按哈希懒更新、不存在
     * 过期态，直接判定为新鲜；只有手工卡片需要重算原文比对——手改时刻意保留了
     * 当时的哈希，预设此后变动即表现为不一致。预设读取失败按新鲜处理，避免把
     * 读取故障误报成过期提示。
     */
    private async isStale(record: PresetPersonaRecord): Promise<boolean> {
        if (record.source !== 'manual') {
            return false
        }

        try {
            const raw = await resolvePresetPrompt(this.ctx, record.presetId)
            return hashPresetText(raw) !== record.rawHash
        } catch {
            return false
        }
    }

    /**
     * 保存手工编辑的卡片：置 `source='manual'` 后不再被自动覆盖，哈希保留用于
     * 判定预设是否已变动。空卡片拒绝写入。
     */
    async saveManualCard(presetId: string, card: string): Promise<void> {
        const trimmedId = presetId.trim()
        if (trimmedId.length === 0) {
            throw new Error('presetId is required')
        }
        if (card.trim().length === 0) {
            throw new Error('persona card must not be empty')
        }

        await this.writes.run(trimmedId, async () => {
            const stored = await this.repository.getPresetPersona(trimmedId)
            await this.repository.upsertPresetPersona({
                presetId: trimmedId,
                card,
                rawHash: stored?.rawHash ?? hashPresetText(card),
                source: 'manual',
                totalLines: splitLines(card).length,
                deletedLines: 0,
                usedRawFallback: false
            })
        })
    }

    /**
     * 丢弃当前卡片（含手工卡片）并按当前预设原文重新生成。生成成功后才替换
     * 落库行；模型侧失败时抛错，落库行保持原状。
     */
    async resetCard(presetId: string): Promise<void> {
        const epoch = this.clearEpoch(presetId)
        const raw = await resolvePresetPrompt(this.ctx, presetId)
        const outcome = await this.prune(raw)
        if (outcome.failure !== null) {
            throw new Error(
                `persona card generation failed: ${outcome.failure}`
            )
        }

        const rawHash = hashPresetText(raw)
        await this.writes.run(presetId, async () => {
            if (this.clearEpoch(presetId) === epoch) {
                await this.persistGenerated(presetId, rawHash, outcome)
            }
        })
    }

    /**
     * 删除预设卡片（含手工卡片），随清空预设数据执行。推进清空纪元，清空前
     * 发起的生成落库时比对失败即放弃写入，不在清空后的预设上写回卡片。
     */
    async clearCard(presetId: string): Promise<void> {
        this.clearEpochs.set(presetId, this.clearEpoch(presetId) + 1)
        await this.writes.run(presetId, () =>
            this.repository.deletePresetPersona(presetId)
        )
    }

    private clearEpoch(presetId: string): number {
        return this.clearEpochs.get(presetId) ?? 0
    }

    private async generate(
        presetId: string,
        raw: string,
        rawHash: string,
        epoch: number
    ): Promise<string> {
        const outcome = await this.prune(raw)
        if (outcome.failure !== null) {
            return outcome.card
        }

        return await this.writes.run(presetId, async () => {
            if (this.clearEpoch(presetId) !== epoch) {
                return outcome.card
            }
            const stored = await this.repository.getPresetPersona(presetId)
            if (stored?.source === 'manual') {
                return stored.card
            }
            try {
                await this.persistGenerated(presetId, rawHash, outcome)
            } catch (error) {
                this.logger.warn(
                    'persona.persist.failed',
                    { presetId, error: summarizeError(error) },
                    error
                )
            }
            return outcome.card
        })
    }

    private async persistGenerated(
        presetId: string,
        rawHash: string,
        outcome: PersonaCardOutcome
    ): Promise<void> {
        await this.repository.upsertPresetPersona({
            presetId,
            card: outcome.card,
            rawHash,
            source: 'generated',
            totalLines: outcome.totalLines,
            deletedLines: outcome.deletedLines,
            usedRawFallback: outcome.usedRawFallback
        })
    }

    /**
     * 模型不可用、调用失败或结构化校验失败时回退原文，并在 `failure` 标明
     * 原因。
     */
    private async prune(raw: string): Promise<PersonaCardOutcome> {
        const lines = splitLines(raw)
        const fallback = (
            failure: PersonaPruneFailure
        ): PersonaCardOutcome => ({
            card: raw,
            totalLines: lines.length,
            deletedLines: 0,
            usedRawFallback: true,
            failure
        })

        let model: ChatLunaChatModel
        try {
            model = await this.createModel()
        } catch (error) {
            this.logger.diagnostic('persona.prune.skipped', {
                reason: 'model-unavailable',
                error: summarizeError(error)
            })
            return fallback('model-unavailable')
        }

        let structuredResult
        try {
            structuredResult = await invokeStructuredOutput({
                model,
                prompt: buildPersonaCardPrompt({ lines }),
                toolName: personaCardResultToolName,
                toolDescription:
                    '提交应当从预设原文中删除的行号列表；' +
                    '无需删除时提交空数组。',
                schema: personaCardResultSchema,
                validateResult: ({ deletedLineNumbers }) => {
                    const invalid = deletedLineNumbers.filter(
                        (lineNumber) =>
                            lineNumber < 1 || lineNumber > lines.length
                    )
                    if (invalid.length > 0) {
                        throw new Error(
                            `超出范围的行号：${invalid.join('、')}；` +
                                `有效范围 1-${lines.length}`
                        )
                    }
                },
                context: {
                    presetId: '',
                    conversationId: 'persona-card'
                },
                logging: {
                    logger: this.logger,
                    workflow: 'persona',
                    stage: 'persona-card'
                }
            })
        } catch (error) {
            this.logger.diagnostic('persona.prune.failed', {
                reason: 'invoke-failed',
                error: summarizeError(error)
            })
            return fallback('invoke-failed')
        }

        if (structuredResult.parseError !== null) {
            this.logger.diagnostic('persona.prune.failed', {
                reason: 'structured-output-failed',
                error: structuredResult.parseError
            })
            return fallback('structured-output-failed')
        }

        return this.applyDeletions(
            raw,
            lines,
            structuredResult.value.deletedLineNumbers
        )
    }

    private applyDeletions(
        raw: string,
        lines: string[],
        deletedLineNumbers: number[]
    ): PersonaCardOutcome {
        const deleted = new Set(deletedLineNumbers)
        const kept = lines.filter((_line, index) => !deleted.has(index + 1))
        const card = kept.join('\n')
        const deletedLines = lines.length - kept.length

        if (deletedLines === 0) {
            return {
                card: raw,
                totalLines: lines.length,
                deletedLines: 0,
                usedRawFallback: false,
                failure: null
            }
        }

        const ratio = deletedLines / lines.length
        const tooShort = card.trim().length < MIN_CARD_LENGTH
        if (ratio > MAX_DELETION_RATIO || tooShort) {
            this.logger.diagnostic('persona.prune.fallback', {
                reason:
                    ratio > MAX_DELETION_RATIO
                        ? 'deletion-ratio-exceeded'
                        : 'card-too-short',
                totalLines: lines.length,
                deletedLines
            })
            return {
                card: raw,
                totalLines: lines.length,
                deletedLines: 0,
                usedRawFallback: true,
                failure: null
            }
        }

        return {
            card,
            totalLines: lines.length,
            deletedLines,
            usedRawFallback: false,
            failure: null
        }
    }

    private async createModel(): Promise<ChatLunaChatModel> {
        const modelId = this.config.mainModel?.trim()
        if (modelId == null || modelId.length === 0) {
            throw new Error('persona card model is not configured')
        }
        const model = await this.ctx.chatluna.createChatModel(modelId)
        if (model.value === undefined) {
            throw new Error('persona card model is unavailable')
        }
        return model.value
    }
}

export const hashPresetText = (raw: string) =>
    createHash('sha256').update(raw).digest('hex')

/**
 * 落库行转展示视图。`presetMissing` 与 `stale` 由调用方判定：前者按当前预设 id
 * 全集，后者只对手工卡片重算原文比哈希（见 `isStale`）。
 */
const toCardInfo = (
    record: PresetPersonaRecord,
    presetMissing: boolean,
    stale: boolean
): PresetPersonaCardInfo => ({
    presetId: record.presetId,
    card: record.card,
    source: record.source,
    totalLines: record.totalLines,
    deletedLines: record.deletedLines,
    usedRawFallback: record.usedRawFallback,
    stale,
    presetMissing,
    updatedAt: record.updatedAt
})

/** 按行切分并归一换行；保留空行以维持行号与原文一致。 */
export const splitLines = (raw: string) => {
    const normalized = raw.replace(/\r\n?/gu, '\n')
    return normalized.split('\n')
}
