import type { LivingMemoryRepository } from '../../persistence/repository'
import type { LivingMemorySearchEngine } from '../recall/memory_search_engine'
import type { LivingMemoryLogger } from '../../logging/logger'
import type { DreamBatch } from './types'

export async function buildIncrementalDreamBatches(
    presetId: string,
    memoryIds: string[],
    repository: Pick<LivingMemoryRepository, 'getEntriesByPresetAndIds'>,
    search: Pick<LivingMemorySearchEngine, 'searchMemoriesDetailed'>,
    logger: LivingMemoryLogger,
    signal?: AbortSignal
) {
    const seeds = await repository.getEntriesByPresetAndIds(presetId, memoryIds)
    const seedById = new Map(seeds.map((entry) => [entry.id, entry]))
    const groups: { seedMemoryId: string; memoryIds: string[] }[] = []
    const untouchedSeedIds: string[] = []
    for (const id of memoryIds) {
        signal?.throwIfAborted()
        const seed = seedById.get(id)
        if (seed === undefined || seed.status !== 'active') {
            untouchedSeedIds.push(id)
            continue
        }
        const hits = await search.searchMemoriesDetailed(
            presetId,
            {
                searchTexts: [seed.content],
                searchKeywords: [],
                memoryTypes: ['all'],
                memoryStatus: 'active'
            },
            undefined,
            memoryIds
        )
        signal?.throwIfAborted()
        logger.diagnosticSummary(() => ({
            event: '增量 Dream 近邻检索完成',
            detail: `预设：${presetId}; 新记忆：${id}; 近邻：${hits.length} 条`,
            blocks: [
                {
                    title: '近邻结果',
                    value: hits.map((hit) => ({
                        id: hit.id,
                        cosineScore: hit.cosineScore,
                        rerankScore: hit.rerankScore
                    }))
                }
            ]
        }))
        if (hits.length === 0) {
            untouchedSeedIds.push(id)
            continue
        }
        groups.push({
            seedMemoryId: id,
            memoryIds: [id, ...hits.map((hit) => hit.id)]
        })
    }

    const entries = await repository.getEntriesByPresetAndIds(presetId, [
        ...new Set(groups.flatMap((group) => group.memoryIds))
    ])
    const activeById = new Map(
        entries
            .filter((entry) => entry.status === 'active')
            .map((entry) => [entry.id, entry])
    )
    const batches: (DreamBatch & { seedMemoryId: string })[] = []
    for (const group of groups) {
        const members = group.memoryIds.flatMap((id) => {
            const entry = activeById.get(id)
            return entry === undefined ? [] : [entry]
        })
        if (!activeById.has(group.seedMemoryId) || members.length <= 1) {
            untouchedSeedIds.push(group.seedMemoryId)
            continue
        }
        batches.push({
            id: `incremental:${group.seedMemoryId}`,
            seedMemoryId: group.seedMemoryId,
            entries: members
        })
    }
    return {
        batches,
        untouchedSeedIds,
        speakerKeys: seeds
            .filter((entry) => entry.status === 'active')
            .flatMap((entry) => entry.speakerKeys)
    }
}

export async function refreshIncrementalDreamBatch(
    presetId: string,
    batch: DreamBatch,
    repository: Pick<
        LivingMemoryRepository,
        'getEntriesByPresetAndIds' | 'listPresetSpeakers'
    >
) {
    const records = await repository.getEntriesByPresetAndIds(
        presetId,
        batch.entries.map((entry) => entry.id)
    )
    const active = new Map(
        records
            .filter((entry) => entry.status === 'active')
            .map((entry) => [entry.id, entry])
    )
    const entries = batch.entries.flatMap((entry) => {
        const current = active.get(entry.id)
        return current === undefined ? [] : [current]
    })
    if (!active.has(batch.seedMemoryId!) || entries.length <= 1) return
    return { entries, speakers: await repository.listPresetSpeakers(presetId) }
}
