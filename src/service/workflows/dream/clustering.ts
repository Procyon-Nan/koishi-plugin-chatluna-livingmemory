import type {
    DreamVectorProvider,
    DreamVectorReadPage
} from '../../../contracts/vector_index'
import type { DreamMemoryEntryRecord } from '../../../contracts/workflows'
import type { LivingMemoryLogger } from '../../logging/logger'
import { createMemoryContentHash } from '../../vector_index/hashes'
import type { DreamCluster } from './types'
import type { DreamWorkerRunner } from './worker/protocol'
import { dreamBatchSize, type DreamVectorMatrix } from './semantic/types'
import { validateDreamPlan } from './semantic/validate'

const vectorReadPageSize = 256
const initialBudgetMs = 30_000
const maxNumericWorkingSetBytes = 128 * 1024 * 1024

export class DreamClusterer {
    constructor(
        private readonly vectors: DreamVectorProvider,
        private readonly worker: DreamWorkerRunner
    ) {}

    async buildClusters(
        presetId: string,
        entries: DreamMemoryEntryRecord[],
        logger?: LivingMemoryLogger,
        signal?: AbortSignal,
        deadline = performance.now() + 180_000
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
        const checkRead = () => {
            signal?.throwIfAborted()
            if (performance.now() >= deadline) {
                throw new Error('Dream 分组准备达到执行期限。')
            }
        }
        checkRead()
        const firstPage = await this.vectors.readDreamVectors(
            presetId,
            sorted.slice(0, vectorReadPageSize).map((entry) => entry.id),
            signal
        )
        const { dimension, embeddingModelId, generation } = firstPage
        const entryCount = sorted.length
        // 包含矩阵、算法临时数组、排序空间、读页和返回标签的同时存活量。
        const numericBytes =
            4 * entryCount * dimension +
            48 * entryCount +
            32 * dimension +
            12 * Math.ceil(entryCount / dreamBatchSize) +
            4 * Math.min(entryCount, vectorReadPageSize) * dimension
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
        const writePage = (page: DreamVectorReadPage, offset: number) => {
            checkRead()
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
            checkRead()
            const page = await this.vectors.readDreamVectors(
                presetId,
                sorted
                    .slice(offset, offset + vectorReadPageSize)
                    .map((entry) => entry.id),
                signal
            )
            writePage(page, offset)
        }
        const readVectorsMs = performance.now() - startedAt
        const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        const cancel = () => Atomics.store(new Int32Array(cancellation), 0, 1)
        signal?.addEventListener('abort', cancel, { once: true })
        try {
            checkRead()
            const { plan, elapsedMs } = await this.worker.bisect(
                {
                    matrix,
                    cancellation,
                    budgetMs: Math.min(
                        initialBudgetMs,
                        deadline - performance.now()
                    )
                },
                (progress) =>
                    logger?.diagnostic('dream.clustering.progress', {
                        ...progress
                    })
            )
            checkRead()
            validateDreamPlan(plan, entryCount)
            const clusters: DreamCluster[] = Array.from(
                { length: plan.clusterCount },
                (_, index) => ({ id: `cluster-${index + 1}`, entries: [] })
            )
            sorted.forEach((entry, row) =>
                clusters[plan.labels[row]].entries.push(entry)
            )
            logger?.diagnostic('dream.clustering.completed', {
                stage: 'initial',
                entryCount,
                dimension,
                embeddingModelId,
                generation,
                seed: 7,
                clusterCount: plan.clusterCount,
                readVectorsMs,
                initialMs: elapsedMs,
                numericWorkingSetBytes: numericBytes,
                sizes: [...plan.sizes]
            })
            return clusters
        } finally {
            signal?.removeEventListener('abort', cancel)
        }
    }
}
