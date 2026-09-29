import type { Context } from 'koishi'
import type {
    PresetPersonaRecord,
    PresetPersonaSource
} from '../../contracts/memory'
import { normalizePresetPersonaRecord } from './normalizers'

export interface PresetPersonaWriteInput {
    presetId: string
    card: string
    rawHash: string
    source: PresetPersonaSource
    totalLines: number
    deletedLines: number
    usedRawFallback: boolean
}

/**
 * 预设人设卡片的表级仓库。卡片是预设级派生缓存（非备份内容），无跨表不变
 * 量，单语句写入即原子，不需要事务。
 */
export class LivingMemoryPresetPersonaRepository {
    constructor(private readonly ctx: Context) {}

    async getPresetPersona(
        presetId: string
    ): Promise<PresetPersonaRecord | undefined> {
        const rows = await this.ctx.database.get('living_memory_preset_persona', {
            presetId
        })
        const row = rows[0]
        return row == null ? undefined : normalizePresetPersonaRecord(row)
    }

    async listPresetPersonas(): Promise<PresetPersonaRecord[]> {
        const rows = await this.ctx.database.get(
            'living_memory_preset_persona',
            {}
        )
        return rows
            .map(normalizePresetPersonaRecord)
            .sort((left, right) => left.presetId.localeCompare(right.presetId))
    }

    async upsertPresetPersona(input: PresetPersonaWriteInput): Promise<void> {
        const presetId = input.presetId.trim()
        if (presetId.length === 0) {
            return
        }

        const now = new Date()
        const stored = {
            presetId,
            card: input.card,
            rawHash: input.rawHash,
            source: input.source,
            totalLines: input.totalLines,
            deletedLines: input.deletedLines,
            usedRawFallback: input.usedRawFallback,
            updatedAt: now
        }
        const existing = (
            await this.ctx.database.get('living_memory_preset_persona', {
                presetId
            })
        )[0]

        if (existing == null) {
            await this.ctx.database.create('living_memory_preset_persona', {
                ...stored,
                createdAt: now
            })
            return
        }

        await this.ctx.database.set(
            'living_memory_preset_persona',
            { presetId },
            stored
        )
    }

    async deletePresetPersona(presetId: string): Promise<void> {
        await this.ctx.database.remove('living_memory_preset_persona', {
            presetId
        })
    }
}
