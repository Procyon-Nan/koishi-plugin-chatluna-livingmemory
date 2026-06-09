import { Context } from 'koishi'
import { LivingMemoryRepository } from '../repository'
import { summarizeError } from '../shared/utils'
import {
    type CharacterPresetProvider,
    characterPresetSuffix,
    type DebugLogger,
    mergePresetIds,
    toPresetIdList
} from './helpers'

export class LivingMemoryPresetCatalog {
    constructor(
        private readonly ctx: Context,
        private readonly repository: LivingMemoryRepository,
        private readonly debug: DebugLogger
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
            this.debug(
                `webui preset list skipped chatluna presets: ${summarizeError(error)}`
            )
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
            this.debug(
                `webui preset list skipped character presets: ${summarizeError(error)}`
            )
            return []
        }
    }
}
