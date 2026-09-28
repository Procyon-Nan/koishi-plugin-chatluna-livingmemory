import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { PresetSpeakerRecord } from '../../../contracts/memory'
import type { DreamMemoryRepository } from '../../../contracts/workflows'
import {
    buildDreamPrompt,
    dreamResultSchema,
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
import type { DreamCluster, DreamOperation, DreamUnitResult } from './types'
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

/**
 * 覆盖校验：模型必须用恰好一个操作覆盖簇内每条记忆（无需改动的用 keep），空
 * operations 与遗漏都视为未处理。缺漏、重复或越簇的 id 抛错，交由结构化输出
 * 的既有纠错重试处理。
 */
const assertClusterCoverage = (
    cluster: DreamCluster,
    operations: DreamOperation[]
) => {
    const clusterIds = new Set(cluster.entries.map((entry) => entry.id))
    const covered = new Set<string>()
    const duplicated = new Set<string>()
    const foreign = new Set<string>()
    for (const operation of operations) {
        for (const id of getDreamOperationMemoryIds(operation)) {
            if (!clusterIds.has(id)) {
                foreign.add(id)
            } else if (covered.has(id)) {
                duplicated.add(id)
            } else {
                covered.add(id)
            }
        }
    }
    const problems: string[] = []
    const missing = [...clusterIds].filter((id) => !covered.has(id))
    if (missing.length > 0) {
        problems.push(`未覆盖的记忆 id：${missing.join('、')}`)
    }
    if (duplicated.size > 0) {
        problems.push(
            `被多个操作重复覆盖的记忆 id：${[...duplicated].join('、')}`
        )
    }
    if (foreign.size > 0) {
        problems.push(`不属于当前簇的记忆 id：${[...foreign].join('、')}`)
    }
    if (problems.length > 0) {
        throw new Error(
            `memory_entries 中的每条记忆都必须被恰好一个操作覆盖；${problems.join('；')}`
        )
    }
}

export class DreamUnitProcessor {
    private readonly executor: DreamExecutor

    constructor(private readonly repository: DreamMemoryRepository) {
        this.executor = new DreamExecutor(repository)
    }

    async process(input: DreamUnitInput): Promise<DreamUnitResult> {
        const prompt = buildDreamPrompt({
            assistantLabel: input.assistantLabel,
            presetPrompt: input.presetPrompt,
            cluster: input.cluster,
            speakers: input.speakers
        })
        let structuredResult
        try {
            structuredResult = await invokeStructuredOutput({
                model: input.model,
                prompt,
                toolName: dreamResultToolName,
                toolDescription:
                    '提交当前 Dream 记忆簇的整理操作。memory_entries 中的每一条记忆都必须被恰好一个 keep/update/merge/archive 操作覆盖，无需改动的记忆用 keep 保留。',
                stringifiedArrayField: 'operations',
                schema: dreamResultSchema,
                validateResult: ({ operations }) => {
                    assertClusterCoverage(input.cluster, operations)
                    for (const operation of operations) {
                        if (
                            operation.action === 'update' ||
                            operation.action === 'merge'
                        ) {
                            const speakerKeys = resolveSpeakerKeysByLabels(
                                operation.memory.speakerLabels,
                                input.speakers
                            )
                            const memoryIds = new Set(
                                getDreamOperationMemoryIds(operation)
                            )
                            const allowedSpeakerKeys = new Set(
                                input.cluster.entries
                                    .filter((entry) => memoryIds.has(entry.id))
                                    .flatMap((entry) => entry.speakerKeys)
                            )
                            if (
                                speakerKeys.some(
                                    (key) => !allowedSpeakerKeys.has(key)
                                )
                            ) {
                                throw new Error(
                                    'speakerLabels 包含当前操作涉及记忆之外的用户'
                                )
                            }
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
