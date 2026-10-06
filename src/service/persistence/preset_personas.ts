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
 * 量，单行 upsert 即可，不需要事务；同一预设的写入由卡片服务串行。
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
        await this.ctx.database.upsert('living_memory_preset_persona', [
            { ...input, updatedAt: new Date() }
        ])
    }

    async deletePresetPersona(presetId: string): Promise<void> {
        await this.ctx.database.remove('living_memory_preset_persona', {
            presetId
        })
    }
}
