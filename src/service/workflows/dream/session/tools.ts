import type { StructuredTool } from '@langchain/core/tools'
import type {
    LivingMemorySearchProvider,
    LivingMemoryUpdateProvider
} from '../../../../contracts/workflows'
import type { LivingMemoryMutationService } from '../../../app/memory_mutation_service'
import { createMemoryTool } from '../../../memory/tools'
import { LivingMemoryFactsCommittedError } from '../../../vector_index/errors'
import {
    assertDreamMemoriesAvailable,
    recordDreamOperation,
    type DreamSessionState
} from './state'

interface DreamSessionToolDependencies {
    presetId: string
    state: DreamSessionState
    search: LivingMemorySearchProvider
    speakers: Pick<LivingMemoryUpdateProvider, 'listPresetSpeakers'>
    mutations: Pick<
        LivingMemoryMutationService,
        | 'updateActiveMemory'
        | 'mergeActiveMemories'
        | 'splitActiveMemory'
        | 'archiveActiveMemories'
        | 'setMemoryConsolidation'
    >
}

export function createDreamSessionTools({
    presetId,
    state,
    search,
    speakers,
    mutations
}: DreamSessionToolDependencies): StructuredTool[] {
    const listPresetSpeakers = () => speakers.listPresetSpeakers(presetId)

    return [
        createMemoryTool.search(
            {
                async searchMemories(_presetId, input) {
                    const results = await search.searchMemories(presetId, input)
                    for (const result of results) {
                        state.availableMemoryIds.add(result.id)
                    }
                    return results
                }
            },
            true
        ),
        createMemoryTool.split({
            listPresetSpeakers,
            async splitActiveMemory(_presetId, sourceMemoryId, memories) {
                assertDreamMemoriesAvailable(state, [sourceMemoryId])
                const result = await mutations.splitActiveMemory(
                    presetId,
                    sourceMemoryId,
                    memories,
                    true
                )
                recordDreamOperation(state, [sourceMemoryId], 'split')
                for (const memory of result.memories) {
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
                        patch,
                        true
                    )
                    if (record !== null) {
                        recordDreamOperation(state, [memoryId], 'updated')
                    }
                    return record
                } catch (error) {
                    if (error instanceof LivingMemoryFactsCommittedError) {
                        recordDreamOperation(state, [memoryId], 'updated')
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
                    memory,
                    true
                )
                recordDreamOperation(state, sourceMemoryIds, 'merged')
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
            const warnings: string[] = []
            try {
                await mutations.setMemoryConsolidation(
                    presetId,
                    memoryIds,
                    true
                )
            } catch (error) {
                if (!(error instanceof LivingMemoryFactsCommittedError)) {
                    throw error
                }
                warnings.push(
                    '记忆已固化，但向量索引同步失败，已调度后台自动对账：' +
                        error.message
                )
            }
            recordDreamOperation(state, memoryIds, 'kept')
            return { warnings }
        })
    ]
}
