import { createHash } from 'crypto'
import type { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type {
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
import { resolvePresetPrompt } from './helpers'

type PresetPersonaConfig = Pick<LivingMemoryConfig, 'mainModel'>

/** 删除比例超过该值即视为删减异常，回退原文。 */
const MAX_DELETION_RATIO = 0.8

/** 剪出的卡片短于该字符数即视为异常，回退原文。 */
const MIN_CARD_LENGTH = 20

/** 启动预热的并发上限，避免同时向模型发起过多请求。 */
const WARMUP_CONCURRENCY = 3

interface PresetPersonaRepository {
    getPresetPersona(presetId: string): Promise<PresetPersonaRecord | undefined>
    upsertPresetPersona(input: {
        presetId: string
        card: string
        rawHash: string
        source: PresetPersonaSource
        totalLines: number
        deletedLines: number
        usedRawFallback: boolean
    }): Promise<void>
}

interface PersonaCardOutcome {
    card: string
    totalLines: number
    deletedLines: number
    usedRawFallback: boolean
    /** 模型侧失败导致的回退：跳过内存层与落库，下次解析时重试。 */
    retryable: boolean
}

/**
 * 预设人设卡片服务。把预设原文按行删减掉纯操作性内容，供记忆提取、Dream 与
 * 用户画像注入；recall 不注入预设，不接入。
 *
 * 两层缓存：
 * - 内存层按原文哈希去重（`memoByHash`），覆盖 extraction 这类高频、每轮现
 *   render 的入口；
 * - 落库层按 presetId（`living_memory_preset_persona`），覆盖跨重启与 WebUI
 *   查看，是唯一写库路径。
 *
 * 落库只走 `resolve(presetId)` 这条无变量路径；`resolveRendered(rawText)` 供
 * 已 render 好的 middleware 闭包使用，只读内存、不落库，避免带会话变量的原文
 * 反复覆盖落库口径。
 */
export class LivingMemoryPresetPersonaService
    implements PresetPersonaResolver
{
    private readonly memoByHash = new Map<string, string>()
    private readonly inFlight = new Map<string, Promise<string>>()

    constructor(
        private readonly ctx: Context,
        private readonly config: PresetPersonaConfig,
        private readonly repository: PresetPersonaRepository,
        private readonly logger: LivingMemoryLogger
    ) {}

    /**
     * 按预设 id 取卡片，是唯一会写库的路径。启动预热与 Dream、画像、手动
     * Dream 均走这里。
     */
    async resolve(presetId: string): Promise<string> {
        const raw = await resolvePresetPrompt(this.ctx, presetId)
        const rawHash = hashPresetText(raw)

        const memoized = this.memoByHash.get(rawHash)
        if (memoized !== undefined) {
            return memoized
        }
        const pending = this.inFlight.get(rawHash)
        if (pending !== undefined) {
            return await pending
        }

        const task = this.resolveAndPersist(presetId, raw, rawHash)
        this.inFlight.set(rawHash, task)
        try {
            return await task
        } finally {
            this.inFlight.delete(rawHash)
        }
    }

    /**
     * 按已 render 好的原文取卡片，只查内存层、不落库。会话变量导致的原文差异
     * 只在内存层生效，不影响落库口径。
     */
    async resolveRendered(rawText: string): Promise<string> {
        const rawHash = hashPresetText(rawText)
        const memoized = this.memoByHash.get(rawHash)
        if (memoized !== undefined) {
            return memoized
        }
        const pending = this.inFlight.get(rawHash)
        if (pending !== undefined) {
            return await pending
        }

        const task = this.buildCard(rawText, rawHash).then(
            (outcome) => outcome.card
        )
        this.inFlight.set(rawHash, task)
        try {
            return await task
        } finally {
            this.inFlight.delete(rawHash)
        }
    }

    /**
     * 启动预热：为传入的每个预设生成缺失或过期的卡片。逐预设兜底，单点失败
     * 不阻塞启动，也不影响懒生成；`manual` 卡片不自动覆盖。
     */
    async warmup(presetIds: string[]): Promise<void> {
        const queue = [...new Set(presetIds)]
        const workers = Array.from(
            { length: Math.min(WARMUP_CONCURRENCY, queue.length) },
            async () => {
                while (queue.length > 0) {
                    const presetId = queue.shift()
                    if (presetId === undefined) {
                        return
                    }
                    try {
                        await this.resolve(presetId)
                    } catch (error) {
                        this.logger.diagnostic('persona.warmup.failed', {
                            presetId,
                            error: summarizeError(error)
                        })
                    }
                }
            }
        )
        await Promise.all(workers)
    }

    private async resolveAndPersist(
        presetId: string,
        raw: string,
        rawHash: string
    ): Promise<string> {
        const existing = await this.repository.getPresetPersona(presetId)
        if (existing != null) {
            this.memoByHash.set(existing.rawHash, existing.card)
            if (existing.source === 'manual') {
                return existing.card
            }
            if (existing.rawHash === rawHash) {
                return existing.card
            }
        }

        const outcome = await this.buildCard(raw, rawHash)
        if (outcome.retryable) {
            return outcome.card
        }
        try {
            await this.repository.upsertPresetPersona({
                presetId,
                card: outcome.card,
                rawHash,
                source: 'generated',
                totalLines: outcome.totalLines,
                deletedLines: outcome.deletedLines,
                usedRawFallback: outcome.usedRawFallback
            })
        } catch (error) {
            this.logger.warn(
                'persona.persist.failed',
                { presetId, error: summarizeError(error) },
                error
            )
        }
        return outcome.card
    }

    /**
     * 生成卡片并写入内存层。模型不可用、调用失败或结构化校验失败时回退原文，
     * 且不写入内存（下次重试）。
     */
    private async buildCard(
        raw: string,
        rawHash: string
    ): Promise<PersonaCardOutcome> {
        const outcome = await this.prune(raw)
        if (!outcome.retryable) {
            this.memoByHash.set(rawHash, outcome.card)
        }
        return outcome
    }

    private async prune(raw: string): Promise<PersonaCardOutcome> {
        const lines = splitLines(raw)
        const fallback: PersonaCardOutcome = {
            card: raw,
            totalLines: lines.length,
            deletedLines: 0,
            usedRawFallback: true,
            retryable: true
        }

        let model: ChatLunaChatModel
        try {
            model = await this.createModel()
        } catch (error) {
            this.logger.diagnostic('persona.prune.skipped', {
                reason: 'model-unavailable',
                error: summarizeError(error)
            })
            return fallback
        }

        let structuredResult
        try {
            structuredResult = await invokeStructuredOutput({
                model,
                prompt: buildPersonaCardPrompt({ lines }),
                toolName: personaCardResultToolName,
                toolDescription:
                    '提交应当从预设原文中删除的行号列表；无需删除时提交空数组。',
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
            return fallback
        }

        if (structuredResult.parseError !== null) {
            this.logger.diagnostic('persona.prune.failed', {
                reason: 'structured-output-failed',
                error: structuredResult.parseError
            })
            return fallback
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
                retryable: false
            }
        }

        const ratio = deletedLines / lines.length
        if (ratio > MAX_DELETION_RATIO || card.trim().length < MIN_CARD_LENGTH) {
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
                retryable: false
            }
        }

        return {
            card,
            totalLines: lines.length,
            deletedLines,
            usedRawFallback: false,
            retryable: false
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

/** 按行切分并归一换行；保留空行以维持行号与原文一致。 */
export const splitLines = (raw: string) => {
    const normalized = raw.replace(/\r\n?/gu, '\n')
    return normalized.split('\n')
}
