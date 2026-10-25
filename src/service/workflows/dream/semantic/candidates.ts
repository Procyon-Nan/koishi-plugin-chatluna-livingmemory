import { setImmediate } from 'node:timers/promises'
import type { DreamVectorProvider } from '../../../../contracts/vector_index'
import type { DreamMemoryEntryRecord } from '../../../../contracts/workflows'
import { createMemoryContentHash } from '../../../vector_index/hashes'
import {
    dreamCandidateWidth,
    dreamNeighborCount,
    type DreamCandidates,
    type DreamPlanLabels,
    type DreamVectorMatrix
} from './types'

export const collectDreamCandidates = async ({
    provider,
    presetId,
    generation,
    entries,
    matrix,
    initial,
    deadline,
    signal
}: {
    provider: DreamVectorProvider
    presetId: string
    generation: string
    entries: DreamMemoryEntryRecord[]
    matrix: DreamVectorMatrix
    initial: DreamPlanLabels
    deadline: number
    signal?: AbortSignal
}) => {
    const startedAt = performance.now()
    const { entryCount, dimension } = matrix
    const candidates: DreamCandidates = {
        q: Math.min(dreamNeighborCount, entryCount - 1),
        counts: new Uint8Array(entryCount),
        neighbors: new Uint32Array(entryCount * dreamCandidateWidth)
    }
    const targets = new Map(
        entries.map((entry, row) => [
            entry.id,
            {
                row,
                hash: createMemoryContentHash(entry.content)
            }
        ])
    )
    const queried = new Uint8Array(entryCount)
    let queriedRows = 0
    let fullCandidateRows = 0
    let directedCandidateCount = 0

    const queryRows = async (rows: number[], retry: boolean) => {
        let offset = 0
        while (offset < rows.length) {
            signal?.throwIfAborted()
            if (performance.now() >= deadline) return 'candidate-budget'
            const pageRows = rows.slice(offset, offset + 4)
            const page = await provider.queryDreamNeighbors(
                pageRows.map((row) => ({
                    sourceIndex: row,
                    presetId,
                    generation,
                    sourceMemoryId: entries[row].id,
                    vector: matrix.vectors.slice(
                        row * dimension,
                        (row + 1) * dimension
                    ),
                    limit: Math.min(retry ? 40 : 20, entryCount - 1),
                    efSearch: retry ? 100 : 40
                })),
                signal
            )
            signal?.throwIfAborted()
            if (page.generation !== generation)
                throw new Error('Dream 候选索引代际已变化。')
            if (
                page.completed !== page.rows.length ||
                page.completed > pageRows.length ||
                (page.backend === 'hnsw' && page.completed === 0)
            ) {
                throw new Error('Dream 候选页完成前缀无效。')
            }
            for (let i = 0; i < page.completed; i++) {
                const { sourceIndex: row, hits } = page.rows[i]
                if (row !== pageRows[i])
                    throw new Error('Dream 候选页行号顺序无效。')
                if (!queried[row]) {
                    queried[row] = 1
                    queriedRows++
                }
                const start = row * dreamCandidateWidth
                const oldCount = candidates.counts[row]
                let count = oldCount
                for (const hit of hits) {
                    const target = targets.get(hit.memoryId)
                    if (
                        target === undefined ||
                        target.row === row ||
                        target.hash !== hit.contentHash
                    )
                        continue
                    if (
                        candidates.neighbors
                            .subarray(start, start + count)
                            .includes(target.row)
                    )
                        continue
                    candidates.neighbors[start + count++] = target.row
                }
                candidates.counts[row] = count
                directedCandidateCount += count - oldCount
                if (oldCount < candidates.q && count >= candidates.q)
                    fullCandidateRows++
            }
            if (page.backend === 'unavailable')
                return page.reason ?? 'ann-unavailable'
            offset += page.completed
            await setImmediate()
        }
        return undefined
    }
    const collectRows = async (rows: number[]) => {
        const reason = await queryRows(rows, false)
        if (reason) return reason
        const short = rows.filter(
            (row) => candidates.counts[row] < candidates.q
        )
        const retryReason = await queryRows(short, true)
        if (retryReason) return retryReason
        if (short.some((row) => candidates.counts[row] < candidates.q))
            return 'candidate-short'
        return undefined
    }

    // 先覆盖分散的初始组，再用稳定行号补齐至多 32 个探测点。
    const firstRows = new Int32Array(initial.clusterCount).fill(-1)
    initial.labels.forEach((group, row) => {
        if (firstRows[group] === -1) firstRows[group] = row
    })
    const probes = new Set<number>()
    const groupProbes = Math.min(32, initial.clusterCount)
    for (let i = 0; i < groupProbes; i++) {
        probes.add(
            firstRows[Math.floor((i * initial.clusterCount) / groupProbes)]
        )
    }
    const probeCount = Math.min(32, entryCount)
    for (let i = 0; i < probeCount && probes.size < probeCount; i++) {
        probes.add(Math.floor((i * entryCount) / probeCount))
    }
    let stopReason = await collectRows([...probes])
    if (!stopReason) {
        const remaining = Array.from(
            { length: entryCount },
            (_, row) => row
        ).filter((row) => !queried[row])
        stopReason = await collectRows(remaining)
    }
    signal?.throwIfAborted()
    if (!stopReason && performance.now() >= deadline)
        stopReason = 'candidate-budget'
    return {
        candidates: stopReason ? undefined : candidates,
        candidateMs: performance.now() - startedAt,
        queriedRows,
        fullCandidateRows,
        directedCandidateCount,
        stopReason: stopReason ?? 'candidates-complete'
    }
}
