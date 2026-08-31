import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    MemoryEntryRecord,
    MemoryMutationInput,
    MemoryScope,
    MemorySourceMessage
} from '../../contracts/memory'
import type {
    MemoryIndexDocument,
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink,
    MemoryIndexUpsert
} from '../../contracts/vector_index'
import type {
    AttributedMemoryItem,
    DreamMemoryRepository,
    DreamMergeInput,
    DreamMemoryMutation,
    ExtractionRepository
} from '../../contracts/workflows'
import { Time } from 'koishi'
import type { LivingMemoryRepository } from '../persistence/repository'
import { DEFAULT_MEMORY_IMPORTANCE } from '../memory/entry_fields'
import { PresetTaskQueue } from '../shared/preset_task_queue'
import { summarizeError } from '../shared/utils'
import { LivingMemoryFactsCommittedError } from '../vector_index/errors'
import type { LivingMemoryLogger } from '../logging/logger'

type MemoryFactRepository = Pick<
    LivingMemoryRepository,
    | 'appendMemories'
    | 'getEntryById'
    | 'getEntriesByPresetAndIds'
    | 'listArchivedEntriesBefore'
    | 'createMemory'
    | 'updateMemory'
    | 'updateMemoryForDream'
    | 'setMemoryConsolidation'
    | 'archiveActiveEntries'
    | 'applyDreamMerge'
    | 'deleteMemory'
    | 'deleteEntries'
    | 'deleteSnapshotsByPreset'
    | 'clearAllByPreset'
    | 'importPresetData'
>

// 批量删除的单批上限：约束 SQL $in 规模与索引同步批次大小。
export const MEMORY_DELETE_BATCH_SIZE = 500
const ARCHIVED_MEMORY_GRACE_PERIOD = 7 * Time.day
const ARCHIVED_MEMORY_DECAY_PERIOD = 180 * Time.day

export class LivingMemoryMutationService
    implements ExtractionRepository, DreamMemoryRepository
{
    private readonly queue = new PresetTaskQueue()

    constructor(
        private readonly repository: MemoryFactRepository,
        private readonly vectorIndex: MemoryIndexMutationSink,
        private readonly logger: LivingMemoryLogger
    ) {}

    async appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: AttributedMemoryItem[]
    ) {
        return this.runPresetMutation(scope.presetId, async () => {
            const records = await this.repository.appendMemories(
                scope,
                sourceOriginMessages,
                extracted
            )
            if (records.length === 0) {
                return records
            }
            await this.applyCommittedMutation({
                presetId: scope.presetId,
                upserts: records.map((record) =>
                    this.upsert(record, 'replace')
                ),
                deletes: []
            })
            return records
        })
    }

    async createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys?: string[]
    ) {
        return this.runPresetMutation(scope.presetId, async () => {
            // 落库前预检索引就绪状态：未就绪时立即失败且零副作用。
            // 仅 createMemory 预检；appendMemories 的提取窗口过期即失，
            // 宁可落库后进入 dirty 由对账修复，也不能丢轮次。
            this.vectorIndex.assertPresetReady(scope.presetId)
            const record = await this.repository.createMemory(
                scope,
                input,
                speakerKeys
            )
            await this.applyCommittedMutation({
                presetId: record.presetId,
                upserts: [this.upsert(record, 'replace')],
                deletes: []
            })
            return record
        })
    }

    async updateMemory(id: string, patch: Partial<MemoryMutationInput>) {
        const current = await this.repository.getEntryById(id)
        if (current === undefined) {
            return null
        }
        return this.runPresetMutation(current.presetId, async () => {
            const result = await this.repository.updateMemory(id, patch)
            if (result === null) {
                return null
            }
            await this.applyCommittedMutation({
                presetId: result.record.presetId,
                upserts: [
                    this.upsert(
                        result.record,
                        this.vectorAction(result.contentChanged)
                    )
                ],
                deletes: []
            })
            return result
        })
    }

    async updateMemoryForDream(
        presetId: string,
        id: string,
        patch: DreamMemoryMutation | { status: 'archived' },
        isConsolidated?: boolean
    ) {
        return this.runPresetMutation(presetId, async () => {
            const result = await this.repository.updateMemoryForDream(
                id,
                patch,
                isConsolidated
            )
            await this.applyCommittedMutation({
                presetId: result.record.presetId,
                upserts: [
                    this.upsert(
                        result.record,
                        this.vectorAction(result.contentChanged)
                    )
                ],
                deletes: []
            })
            return result
        })
    }

    async setMemoryConsolidation(
        presetId: string,
        ids: string[],
        isConsolidated: boolean
    ) {
        return this.runPresetMutation(presetId, async () => {
            const activeIds = (
                await this.repository.getEntriesByPresetAndIds(presetId, ids)
            )
                .filter((entry) => entry.status === 'active')
                .map((entry) => entry.id)
            const records = await this.repository.setMemoryConsolidation(
                presetId,
                activeIds,
                isConsolidated
            )
            if (records.length === 0) {
                return records
            }
            await this.applyCommittedMutation({
                presetId,
                upserts: records.map((record) =>
                    this.upsert(record, 'preserve')
                ),
                deletes: []
            })
            return records
        })
    }

    async archiveActiveMemories(presetId: string, ids: string[]) {
        const uniqueIds = [...new Set(ids)]
        if (uniqueIds.length === 0) {
            return { archived: 0 }
        }
        return this.runPresetMutation(presetId, async () => {
            let archived = 0
            let snapshotsCleared = false
            for (
                let start = 0;
                start < uniqueIds.length;
                start += MEMORY_DELETE_BATCH_SIZE
            ) {
                const records =
                    await this.repository.archiveActiveEntries(
                        presetId,
                        uniqueIds.slice(
                            start,
                            start + MEMORY_DELETE_BATCH_SIZE
                        )
                    )
                if (records.length === 0) {
                    continue
                }
                if (!snapshotsCleared) {
                    await this.repository.deleteSnapshotsByPreset(presetId)
                    snapshotsCleared = true
                }
                await this.applyCommittedMutation({
                    presetId,
                    upserts: records.map((record) =>
                        this.upsert(record, 'preserve')
                    ),
                    deletes: []
                })
                archived += records.length
            }
            return { archived }
        })
    }

    async applyDreamMerge(input: DreamMergeInput) {
        return this.runPresetMutation(input.presetId, async () => {
            const result = await this.repository.applyDreamMerge(input)
            const upserts = [
                this.upsert(
                    result.target,
                    this.vectorAction(result.targetContentChanged)
                ),
                ...result.archivedSources.map((source: MemoryEntryRecord) =>
                    this.upsert(source, 'preserve')
                )
            ]
            await this.applyCommittedMutation({
                presetId: result.target.presetId,
                upserts,
                deletes: []
            })
            return result
        })
    }

    async deleteMemory(id: string) {
        const current = await this.repository.getEntryById(id)
        if (current === undefined) {
            return null
        }
        return this.runPresetMutation(current.presetId, async () => {
            const record = await this.repository.deleteMemory(id)
            if (record === null) {
                return null
            }
            await this.applyCommittedMutation({
                presetId: record.presetId,
                upserts: [],
                deletes: [{ id: record.id, presetId: record.presetId }]
            })
            return record
        })
    }

    async deleteMemories(presetId: string, ids: string[]) {
        const uniqueIds = [...new Set(ids)]
        if (uniqueIds.length === 0) {
            return { deleted: 0 }
        }
        return this.runPresetMutation(presetId, async () => {
            let deleted = 0
            for (
                let start = 0;
                start < uniqueIds.length;
                start += MEMORY_DELETE_BATCH_SIZE
            ) {
                const batch = uniqueIds.slice(
                    start,
                    start + MEMORY_DELETE_BATCH_SIZE
                )
                // 先按存在性与 preset 归属过滤：并发已删除或跨 preset
                // 的 id 幂等跳过，不中断整批。
                const records = await this.repository.getEntriesByPresetAndIds(
                    presetId,
                    batch
                )
                if (records.length === 0) {
                    continue
                }
                const validIds = records.map((record) => record.id)
                await this.repository.deleteEntries(presetId, validIds)
                await this.applyCommittedMutation({
                    presetId,
                    upserts: [],
                    deletes: validIds.map((id) => ({ id, presetId }))
                })
                deleted += validIds.length
            }
            return { deleted }
        })
    }

    async deleteExpiredArchivedMemories(presetId: string, now: Date) {
        return this.runPresetMutation(presetId, async () => {
            const records = await this.repository.listArchivedEntriesBefore(
                presetId,
                new Date(now.getTime() - ARCHIVED_MEMORY_GRACE_PERIOD)
            )
            const expiredIds = records
                .filter((record) => {
                    const importance =
                        record.importance ?? DEFAULT_MEMORY_IMPORTANCE
                    return (
                        record.updatedAt.getTime() +
                            ARCHIVED_MEMORY_GRACE_PERIOD +
                            importance * ARCHIVED_MEMORY_DECAY_PERIOD <=
                        now.getTime()
                    )
                })
                .map((record) => record.id)

            let deleted = 0
            for (
                let start = 0;
                start < expiredIds.length;
                start += MEMORY_DELETE_BATCH_SIZE
            ) {
                const ids = expiredIds.slice(
                    start,
                    start + MEMORY_DELETE_BATCH_SIZE
                )
                await this.repository.deleteEntries(presetId, ids)
                await this.applyCommittedMutation({
                    presetId,
                    upserts: [],
                    deletes: ids.map((id) => ({ id, presetId }))
                })
                deleted += ids.length
            }
            return { deleted }
        })
    }

    async clearPresetData(presetId: string) {
        await this.runPresetMutation(presetId, async () => {
            await this.repository.clearAllByPreset(presetId)
            try {
                await this.vectorIndex.clearPreset(presetId)
            } catch (error) {
                throw this.factsCommittedError(presetId, error)
            }
        })
    }

    async importPreset(
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ): Promise<LivingMemoryPresetImportResult> {
        return this.runPresetMutation(targetPresetId, async () => {
            const result = await this.repository.importPresetData(
                targetPresetId,
                data
            )
            try {
                const indexJob = await this.vectorIndex.reconcilePreset(
                    targetPresetId,
                    'preset import'
                )
                return { ...result, indexJobId: indexJob.id }
            } catch (error) {
                throw this.factsCommittedError(targetPresetId, error)
            }
        })
    }

    private async applyCommittedMutation(batch: MemoryIndexMutationBatch) {
        try {
            await this.vectorIndex.applyMutation(batch)
        } catch (error) {
            // 事实已提交而索引同步失败：调度一次后台对账自愈，
            // 把 preset 从 dirty 恢复到 ready，避免召回持续失败直到重启。
            this.scheduleIndexReconcile(batch.presetId)
            throw this.factsCommittedError(batch.presetId, error)
        }
    }

    private scheduleIndexReconcile(presetId: string) {
        this.vectorIndex
            .reconcilePreset(presetId, 'mutation index sync failure')
            .catch((error: unknown) => {
                this.logger.warn(
                    'memory.index.reconcile.failed',
                    {
                        workflow: 'memory',
                        operation: 'schedule-index-reconcile',
                        presetId
                    },
                    error
                )
            })
    }

    private runPresetMutation<T>(presetId: string, task: () => Promise<T>) {
        return this.queue.run(presetId, async () => {
            await this.vectorIndex.waitForMaintenance()
            return task()
        })
    }

    private upsert(
        record: MemoryEntryRecord,
        vectorAction: MemoryIndexUpsert['vectorAction']
    ): MemoryIndexUpsert {
        return {
            document: this.document(record),
            vectorAction
        }
    }

    private document(record: MemoryEntryRecord): MemoryIndexDocument {
        return {
            id: record.id,
            presetId: record.presetId,
            status: record.status,
            type: record.type,
            isConsolidated: record.isConsolidated,
            content: record.content,
            keywords: record.keywords,
            updatedAt: record.updatedAt
        }
    }

    private vectorAction(
        contentChanged: boolean
    ): MemoryIndexUpsert['vectorAction'] {
        if (contentChanged) {
            return 'replace'
        }
        return 'preserve'
    }

    private factsCommittedError(presetId: string, error: unknown) {
        return new LivingMemoryFactsCommittedError(
            `memory facts committed but vector index synchronization failed: ` +
                `preset=${presetId}: ${summarizeError(error)}`,
            { cause: error }
        )
    }
}
