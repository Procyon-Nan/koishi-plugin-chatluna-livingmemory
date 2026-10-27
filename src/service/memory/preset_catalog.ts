import { Context } from 'koishi'
import {
    type CharacterPresetProvider,
    characterPresetSuffix,
    mergePresetIds,
    toPresetIdList
} from './helpers'

interface StoredPresetCatalogRepository {
    listDistinctPresetIds(): Promise<string[]>
}

export class LivingMemoryPresetCatalog {
    constructor(
        private readonly ctx: Context,
        private readonly repository: StoredPresetCatalogRepository
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
        return toPresetIdList(
            this.ctx.chatluna.preset.getAllPreset(false).value
        )
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

        return toPresetIdList(await presetProvider.getAllPreset()).map(
            (presetId) => `${presetId}${characterPresetSuffix}`
        )
    }
}
