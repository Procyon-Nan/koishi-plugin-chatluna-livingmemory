import type {
    DreamVectorProvider,
    VectorSnapshot
} from '../../../contracts/vector_index'
import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import type { LivingMemoryLogger } from '../../logging/logger'
import { createMemoryContentHash } from '../../vector_index/hashes'
import type { DreamCluster } from './types'
import type { DreamWorkerRunner } from './worker/protocol'
import {
    dreamBatchSize,
    dreamCandidateWidth,
    dreamNeighborCount,
    type DreamVectorMatrix
} from './semantic/types'
import { validateDreamPlan } from './semantic/validate'
import { collectDreamCandidates } from './semantic/candidates'

const vectorReadPageSize = 256
const maxNumericWorkingSetBytes = 128 * 1024 * 1024

const stopReasonLabels: Record<string, string> = {
    'single-group': '全部记忆组成单批次',
    'index-absent': '近邻索引待就绪',
    'ann-unavailable': '近邻查询暂停',
    budget: '近邻查询达到预算',
    'candidate-short': '有效候选数量低于构图要求',
    'empty-graph': '近邻图边权全部为零',
    'refine-passes': '完成 3 轮优化',
    'local-optimum': '本轮分组保持稳定',
    'edge-budget': '达到边访问上限'
}

export class DreamClusterer {
    constructor(
        private readonly vectors: DreamVectorProvider,
        private readonly worker: DreamWorkerRunner
    ) {}

    async buildClusters(
        presetId: string,
        entries: DreamMemoryEntryRecord[],
        logger?: LivingMemoryLogger,
        signal?: AbortSignal
    ): Promise<DreamCluster[]> {
        if (entries.length === 0) return []
        const startedAt = performance.now()
        const sorted = [...entries].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        )
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i - 1].id === sorted[i].id) {
                throw new Error(`Dream 目标记忆 ID 重复：${sorted[i].id}`)
            }
        }
        signal?.throwIfAborted()
        const firstPage = await this.vectors.readVectorSnapshot(
            presetId,
            sorted.slice(0, vectorReadPageSize).map((entry) => entry.id),
            signal
        )
        const { dimension, embeddingModelId, generation } = firstPage
        const entryCount = sorted.length
        // 包含矩阵、算法临时数组、排序空间、读页和返回标签的同时存活量。
        const initialBytes =
            4 * entryCount * dimension +
            48 * entryCount +
            32 * dimension +
            12 * Math.ceil(entryCount / dreamBatchSize) +
            4 * Math.min(entryCount, vectorReadPageSize) * dimension
        // 构图峰值含候选、top-q、排序键与次序、CSR 和标签检查点。
        const refineBytes =
            4 * entryCount * dimension +
            entryCount *
                (4 * dreamCandidateWidth + 1 + 64 * dreamNeighborCount + 96) +
            32 * Math.ceil(entryCount / dreamBatchSize) +
            16 * dimension +
            1024
        const numericBytes = Math.max(initialBytes, refineBytes)
        if (
            !Number.isInteger(dimension) ||
            dimension < 1 ||
            !Number.isSafeInteger(numericBytes) ||
            numericBytes > maxNumericWorkingSetBytes
        ) {
            throw new Error(
                `Dream 数值工作集超出预算或维数无效：bytes=${numericBytes}, dimension=${dimension}`
            )
        }
        const matrix: DreamVectorMatrix = {
            entryCount,
            dimension,
            vectors: new Float32Array(entryCount * dimension)
        }
        const writePage = (page: VectorSnapshot, offset: number) => {
            signal?.throwIfAborted()
            if (
                page.embeddingModelId !== embeddingModelId ||
                page.dimension !== dimension ||
                page.generation !== generation
            ) {
                throw new Error('Dream 向量模型、维数或索引代际已变化。')
            }
            if (page.missingMemoryIds.length > 0) {
                throw new Error(
                    `Dream 向量缺失：${page.missingMemoryIds.join(', ')}`
                )
            }
            const items = new Map(
                page.items.map((item) => [item.memoryId, item])
            )
            const end = Math.min(offset + vectorReadPageSize, entryCount)
            for (let row = offset; row < end; row++) {
                const entry = sorted[row]
                const item = items.get(entry.id)!
                if (
                    item.status !== 'active' ||
                    item.contentHash !==
                        createMemoryContentHash(entry.content) ||
                    item.vector.length !== dimension
                ) {
                    throw new Error(
                        `Dream 正文与向量快照不符：memoryId=${entry.id}`
                    )
                }
                matrix.vectors.set(item.vector, row * dimension)
            }
        }
        writePage(firstPage, 0)
        // 已复制的首读页释放向量引用，后续页逐页处理。
        firstPage.items = []
        for (
            let offset = vectorReadPageSize;
            offset < entryCount;
            offset += vectorReadPageSize
        ) {
            signal?.throwIfAborted()
            const page = await this.vectors.readVectorSnapshot(
                presetId,
                sorted
                    .slice(offset, offset + vectorReadPageSize)
                    .map((entry) => entry.id),
                signal
            )
            writePage(page, offset)
        }
        const readVectorsMs = performance.now() - startedAt
        logger?.summary('Dream 向量准备完成', [
            `记忆数量：${entryCount} 条`,
            `向量模型：${embeddingModelId}`,
            `向量维度：${dimension}`,
            `耗时：${Math.round(readVectorsMs)} 毫秒`
        ])
        const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        const cancel = () => Atomics.store(new Int32Array(cancellation), 0, 1)
        signal?.addEventListener('abort', cancel, { once: true })
        try {
            signal?.throwIfAborted()
            const initial = await this.worker.bisect({ matrix, cancellation })
            signal?.throwIfAborted()
            let plan = initial.plan
            validateDreamPlan(plan, entryCount)
            logger?.summary(
                'Dream 初始分组完成',
                `生成 ${plan.clusterCount} 批，每批最多 ${dreamBatchSize} 条，耗时 ${Math.round(initial.elapsedMs)} 毫秒`
            )
            let stage = 'initial'
            let stopReason = 'single-group'
            if (plan.clusterCount > 1) {
                const { candidates, ...stats } = await collectDreamCandidates({
                    provider: this.vectors,
                    presetId,
                    generation,
                    entries: sorted,
                    matrix: initial.matrix,
                    initial: plan,
                    signal
                })
                logger?.summary('Dream 近邻查询结束', [
                    `覆盖记忆：${stats.queriedRows}/${entryCount} 条`,
                    `满足构图要求：${stats.fullCandidateRows}/${entryCount} 条`,
                    `候选关系：${stats.directedCandidateCount} 条`,
                    `耗时：${Math.round(stats.candidateMs)} 毫秒`
                ])
                stopReason = stats.stopReason
                if (candidates) {
                    const refined = await this.worker.refine({
                        matrix: initial.matrix,
                        initial: {
                            labels: plan.labels.slice(),
                            sizes: plan.sizes.slice(),
                            clusterCount: plan.clusterCount
                        },
                        candidates,
                        cancellation
                    })
                    signal?.throwIfAborted()
                    const diagnostics = refined.diagnostics
                    stopReason = diagnostics.stopReason
                    if (refined.outcome === 'refined') {
                        plan = refined.plan
                        validateDreamPlan(plan, entryCount)
                        stage = 'refined'
                    }
                    const { initialObjective, finalObjective } = diagnostics
                    let score = `组内近邻得分：${initialObjective.toFixed(2)} → ${finalObjective.toFixed(2)}`
                    if (initialObjective > 0) {
                        score += `（提升 ${((finalObjective / initialObjective - 1) * 100).toFixed(1)}%）`
                    }
                    logger?.summary('Dream 分组优化结束', [
                        `近邻图：${diagnostics.graphEdgeCount} 条边`,
                        `调整操作：移动 ${diagnostics.acceptedMoves} 次，交换 ${diagnostics.acceptedSwaps} 次`,
                        score,
                        `停止原因：${stopReasonLabels[stopReason]}`,
                        `耗时：${Math.round(diagnostics.refineMs)} 毫秒`
                    ])
                }
            }
            const clusters: DreamCluster[] = Array.from(
                { length: plan.clusterCount },
                (_, index) => ({ id: `cluster-${index + 1}`, entries: [] })
            )
            sorted.forEach((entry, row) =>
                clusters[plan.labels[row]].entries.push(entry)
            )
            const summary = [
                `共 ${plan.clusterCount} 批，覆盖 ${entryCount} 条记忆`,
                `每批条数：${[...plan.sizes].join('、')}`,
                `分组总耗时：${Math.round(performance.now() - startedAt)} 毫秒`
            ]
            if (stage === 'initial') {
                summary.push(`采用初始分组：${stopReasonLabels[stopReason]}`)
            }
            logger?.summary('Dream 分组完成', summary)
            return clusters
        } finally {
            signal?.removeEventListener('abort', cancel)
        }
    }
}
