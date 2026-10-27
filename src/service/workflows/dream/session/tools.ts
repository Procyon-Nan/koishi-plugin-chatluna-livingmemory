import type { StructuredTool } from '@langchain/core/tools'
import type { LivingMemoryRepository } from '../../../persistence/repository'
import { MemoryInputError } from '../../../memory/errors'
import type { LivingMemoryMutationService } from '../../../app/memory_mutation_service'
import { createMemoryTool } from '../../../memory/tools'
import { LivingMemoryFactsCommittedError } from '../../../vector_index/errors'
import {
    assertDreamMemoriesAvailable,
    recordDreamOperation,
    recordDreamProfileSpeakers,
    type DreamSessionState
} from './state'

interface DreamSessionToolDependencies {
    presetId: string
    state: DreamSessionState
    repository: Pick<
        LivingMemoryRepository,
        'listPresetSpeakers' | 'getEntriesByPresetAndIds'
    >
    mutations: Pick<
        LivingMemoryMutationService,
        | 'updateActiveMemory'
        | 'mergeActiveMemories'
        | 'splitActiveMemory'
        | 'archiveActiveMemories'
    >
}

export function createDreamSessionTools({
    presetId,
    state,
    repository,
    mutations
}: DreamSessionToolDependencies): StructuredTool[] {
    const listPresetSpeakers = () => repository.listPresetSpeakers(presetId)

    return [
        createMemoryTool.split({
            listPresetSpeakers,
            async splitActiveMemory(_presetId, sourceMemoryId, memories) {
                assertDreamMemoriesAvailable(state, [sourceMemoryId])
                const result = await mutations.splitActiveMemory(
                    presetId,
                    sourceMemoryId,
                    memories
                )
                recordDreamOperation(state, [sourceMemoryId], 'split')
                for (const memory of result.memories) {
                    recordDreamProfileSpeakers(state, memory.speakerKeys)
                    state.availableMemoryIds.add(memory.id)
                }
                return result
            }
        }),
        createMemoryTool.update({
            listPresetSpeakers,
            async updateActiveMemory(_presetId, memoryId, patch) {
                assertDreamMemoriesAvailable(state, [memoryId])
                try {
                    const record = await mutations.updateActiveMemory(
                        presetId,
                        memoryId,
                        patch
                    )
                    if (record !== null) {
                        recordDreamOperation(state, [memoryId], 'updated')
                        recordDreamProfileSpeakers(state, record.speakerKeys)
                    }
                    return record
                } catch (error) {
                    if (error instanceof LivingMemoryFactsCommittedError) {
                        recordDreamOperation(state, [memoryId], 'updated')
                        recordDreamProfileSpeakers(state, patch.speakerKeys!)
                    }
                    throw error
                }
            }
        }),
        createMemoryTool.merge({
            listPresetSpeakers,
            async mergeActiveMemories(_presetId, sourceMemoryIds, memory) {
                assertDreamMemoriesAvailable(state, sourceMemoryIds)
                const result = await mutations.mergeActiveMemories(
                    presetId,
                    sourceMemoryIds,
                    memory
                )
                recordDreamOperation(state, sourceMemoryIds, 'merged')
                recordDreamProfileSpeakers(state, result.memory.speakerKeys)
                state.availableMemoryIds.add(result.memory.id)
                return result
            }
        }),
        createMemoryTool.delete({
            async archiveActiveMemories(_presetId, memoryIds) {
                assertDreamMemoriesAvailable(state, memoryIds)
                try {
                    const result = await mutations.archiveActiveMemories(
                        presetId,
                        memoryIds
                    )
                    if (result.archived > 0) {
                        recordDreamOperation(state, memoryIds, 'archived')
                    }
                    return result
                } catch (error) {
                    if (error instanceof LivingMemoryFactsCommittedError) {
                        recordDreamOperation(state, memoryIds, 'archived')
                    }
                    throw error
                }
            }
        }),
        createMemoryTool.checked(async ({ memoryIds }) => {
            assertDreamMemoriesAvailable(state, memoryIds)
            const entries = await repository.getEntriesByPresetAndIds(
                presetId,
                memoryIds
            )
            const activeIds = new Set(
                entries
                    .filter((entry) => entry.status === 'active')
                    .map((entry) => entry.id)
            )
            const missing = memoryIds.filter((id) => !activeIds.has(id))
            if (missing.length > 0) {
                throw new MemoryInputError(
                    `请核对以下记忆的活跃状态：${missing.join('、')}。`
                )
            }
            recordDreamOperation(state, memoryIds, 'kept')
            return { warnings: [] }
        })
    ]
}
