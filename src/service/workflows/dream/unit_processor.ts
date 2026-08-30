import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { PresetSpeakerRecord } from '../../../contracts/memory'
import type { DreamMemoryRepository } from '../../../contracts/workflows'
import {
    buildDreamPrompt,
    dreamResultSchema,
    dreamResultToolDescription,
    dreamResultToolName
} from '../../prompts'
import { summarizeError } from '../../shared/utils'
import {
    invokeStructuredOutput,
    isStructuredOutputModelInvocationError
} from '../structured_output'
import { resolveSpeakerKeysByLabels } from '../../memory/speaker_identity'
import { DreamExecutor, getDreamOperationMemoryIds } from './executor'
import { createEmptyStats } from './stats'
import type {
    DreamCluster,
    DreamOperation,
    DreamUnitResult
} from './types'
import type { LivingMemoryLogger } from '../../logging/logger'

interface DreamUnitBaseInput {
    presetId: string
    assistantLabel: string
    presetPrompt: string
    cluster: DreamCluster
    speakers: PresetSpeakerRecord[]
    model: ChatLunaChatModel
    touchedMemoryIds: Set<string>
    logger?: LivingMemoryLogger
}

export type DreamUnitInput =
    | (DreamUnitBaseInput & { consolidationMode: 'manual' })
    | (DreamUnitBaseInput & { consolidationMode: 'incremental-batch' })
    | (DreamUnitBaseInput & {
          consolidationMode: 'incremental-seed'
          focusMemoryId: string
      })

export class DreamUnitProcessor {
    private readonly executor: DreamExecutor

    constructor(private readonly repository: DreamMemoryRepository) {
        this.executor = new DreamExecutor(repository)
    }

    async process(input: DreamUnitInput): Promise<DreamUnitResult> {
        const prompt = buildDreamPrompt({
            assistantLabel: input.assistantLabel,
            presetPrompt: input.presetPrompt,
            presetId: input.presetId,
            cluster: input.cluster,
            speakers: input.speakers
        })
        let structuredResult
        try {
            structuredResult = await invokeStructuredOutput({
                model: input.model,
                prompt,
                toolName: dreamResultToolName,
                toolDescription: dreamResultToolDescription,
                stringifiedArrayField: 'operations',
                schema: dreamResultSchema,
                validateResult: ({ operations }) => {
                    for (const operation of operations) {
                        if (
                            operation.action === 'update' ||
                            operation.action === 'merge'
                        ) {
                            resolveSpeakerKeysByLabels(
                                operation.memory.speakerLabels,
                                input.speakers
                            )
                        }
                    }
                },
                context: {
                    presetId: input.presetId,
                    conversationId: [
                        'dream',
                        input.presetId,
                        input.cluster.id
                    ].join(':')
                },
                logging:
                    input.logger == null
                        ? undefined
                        : {
                              logger: input.logger,
                              workflow: 'dream',
                              stage: 'dream',
                              fields: {
                                  clusterId: input.cluster.id,
                                  consolidationMode: input.consolidationMode
                              }
                          }
            })
        } catch (error) {
            if (!isStructuredOutputModelInvocationError(error)) {
                throw error
            }
            const errorSummary = summarizeError(error)
            input.logger?.diagnostic('dream.model.failed', {
                clusterId: input.cluster.id,
                reason: 'invoke-failed',
                error: errorSummary
            })
            return this.failure(`invoke-failed: ${errorSummary}`)
        }

        if (structuredResult.parseError !== null) {
            const parseError = structuredResult.parseError
            return this.failure(`structured-output-failed: ${parseError}`)
        }

        const operations = structuredResult.value.operations as DreamOperation[]
        if (
            input.consolidationMode === 'incremental-seed' &&
            operations.length > 0 &&
            !operations.some((operation) =>
                getDreamOperationMemoryIds(operation).includes(
                    input.focusMemoryId
                )
            )
        ) {
            return this.failure('seed-not-in-operations')
        }
        const result = await this.executor.executeOperations(
            input.presetId,
            input.cluster,
            operations,
            input.touchedMemoryIds,
            input.consolidationMode,
            input.speakers,
            input.logger
        )
        if (result.skipped > 0) {
            return {
                success: false,
                error: 'invalid-or-conflicting-operations',
                ...result
            }
        }
        await this.finishConsolidation(input, result.consolidatedMemoryIds)
        return {
            success: true,
            ...result
        }
    }

    private async finishConsolidation(
        input: DreamUnitInput,
        alreadyConsolidated: Set<string>
    ) {
        if (input.consolidationMode === 'incremental-batch') {
            return
        }
        let ids: string[]
        if (input.consolidationMode === 'manual') {
            ids = input.cluster.entries.map((entry) => entry.id)
        } else {
            ids = [input.focusMemoryId]
        }
        const pendingIds = ids.filter((id) => !alreadyConsolidated.has(id))
        if (pendingIds.length > 0) {
            await this.repository.setMemoryConsolidation(
                input.presetId,
                pendingIds,
                true
            )
        }
    }

    private failure(error: string): DreamUnitResult {
        return {
            success: false,
            error,
            ...createEmptyStats(),
            consolidatedMemoryIds: new Set(),
            mutatedMemoryIds: new Set()
        }
    }
}
