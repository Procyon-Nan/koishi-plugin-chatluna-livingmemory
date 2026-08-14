import { Context } from 'koishi'
import { summarizeError } from '../shared/utils'
import {
    type CharacterPresetProvider,
    characterPresetSuffix,
    mergePresetIds,
    toPresetIdList
} from './helpers'
import type { LivingMemoryLogger } from '../logging/logger'

interface StoredPresetCatalogRepository {
    listDistinctPresetIds(): Promise<string[]>
}

export class LivingMemoryPresetCatalog {
    constructor(
        private readonly ctx: Context,
        private readonly repository: StoredPresetCatalogRepository,
        private readonly logger: LivingMemoryLogger
    ) {}

    async list(): Promise<string[]> {
        const configuredChatLunaPresetIds = this.listChatLuna()
        const [configuredCharacterPresetIds, storedPresetIds] =
            await Promise.all([
                this.listCharacter(),
                this.repository.listDistinctPresetIds()
            ])

        return mergePresetIds(
            configuredChatLunaPresetIds,
            configuredCharacterPresetIds,
            storedPresetIds.sort((left, right) => left.localeCompare(right))
        )
    }

    private listChatLuna(): string[] {
        try {
            return toPresetIdList(
                this.ctx.chatluna.preset.getAllPreset(false).value
            )
        } catch (error) {
            this.logger.diagnostic('preset.catalog.skipped', {
                workflow: 'webui',
                source: 'chatluna',
                error: summarizeError(error)
            })
            return []
        }
    }

    private async listCharacter(): Promise<string[]> {
        const character = (
            this.ctx as Context & {
                chatluna_character?: CharacterPresetProvider
            }
        ).chatluna_character
        const presetProvider = character?.preset

        if (presetProvider?.getAllPreset == null) {
            return []
        }

        try {
            return toPresetIdList(await presetProvider.getAllPreset()).map(
                (presetId) => `${presetId}${characterPresetSuffix}`
            )
        } catch (error) {
            this.logger.diagnostic('preset.catalog.skipped', {
                workflow: 'webui',
                source: 'character',
                error: summarizeError(error)
            })
            return []
        }
    }
}
