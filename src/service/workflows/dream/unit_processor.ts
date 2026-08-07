import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { DreamMemoryRepository } from '../../../contracts/workflows'
import {
    buildDreamPrompt,
    dreamActiveResultSchema,
    dreamArchivedResultSchema,
    dreamResultToolDescription,
    dreamResultToolName
} from '../../prompts'
import { formatPromptMessagesTrace } from '../../prompts/prompt_format'
import { summarizeError } from '../../shared/utils'
import {
    invokeStructuredOutput,
    isStructuredOutputModelInvocationError
} from '../structured_output'
import { DreamExecutor, getDreamOperationMemoryIds } from './executor'
import { createEmptyStats } from './stats'
import type {
    DreamCluster,
    DreamOperation,
    DreamStage,
    DreamUnitResult
} from './types'

interface DreamUnitBaseInput {
    presetId: string
    assistantLabel: string
    presetPrompt: string
    stage: DreamStage
    cluster: DreamCluster
    model: ChatLunaChatModel
    touchedMemoryIds: Set<string>
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

    constructor(
        private readonly repository: DreamMemoryRepository,
        private readonly debug: (message: string) => void,
        private readonly enableTrace: boolean
    ) {
        this.executor = new DreamExecutor(repository, debug)
    }

    async process(input: DreamUnitInput): Promise<DreamUnitResult> {
        const prompt = buildDreamPrompt({
            assistantLabel: input.assistantLabel,
            presetPrompt: input.presetPrompt,
            presetId: input.presetId,
            cluster: input.cluster,
            stage: input.stage
        })
        this.trace(() =>
            [
                `memory dream llm input: presetId=${input.presetId}`,
                `stage=${input.stage}`,
                `clusterId=${input.cluster.id}`,
                formatPromptMessagesTrace(prompt)
            ].join('\n')
        )

        let structuredResult
        let schema:
            typeof dreamActiveResultSchema | typeof dreamArchivedResultSchema =
            dreamActiveResultSchema
        if (input.stage === 'archived') {
            schema = dreamArchivedResultSchema
        }
        try {
            structuredResult = await invokeStructuredOutput({
                model: input.model,
                prompt,
                toolName: dreamResultToolName,
                toolDescription: dreamResultToolDescription,
                stringifiedArrayField: 'operations',
                schema,
                context: {
                    presetId: input.presetId,
                    conversationId: [
                        'dream',
                        input.presetId,
                        input.stage,
                        input.cluster.id
                    ].join(':')
                }
            })
        } catch (error) {
            if (!isStructuredOutputModelInvocationError(error)) {
                throw error
            }
            return this.failure(`invoke-failed: ${summarizeError(error)}`)
        }

        this.trace(() =>
            [
                `memory dream llm output: presetId=${input.presetId}`,
                `stage=${input.stage}`,
                `clusterId=${input.cluster.id}`,
                structuredResult.output
            ].join('\n')
        )

        if (structuredResult.parseError !== null) {
            return this.failure(
                `structured-output-failed: ${structuredResult.parseError}`
            )
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
            input.stage,
            input.cluster,
            operations,
            input.touchedMemoryIds,
            input.consolidationMode
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
            await this.repository.setMemoryConsolidation(pendingIds, true)
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

    private trace(buildMessage: () => string) {
        if (this.enableTrace) {
            this.debug(buildMessage())
        }
    }
}
