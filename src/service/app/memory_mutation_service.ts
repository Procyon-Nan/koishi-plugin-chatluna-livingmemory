import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    MemoryEntryRecord,
    MemoryMutationInput,
    MemoryUpdatePatch,
    MemoryScope,
    MemorySourceMessage,
    PresetSpeakerRecord
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
    DreamSpeakerCoverage,
    ExtractionMemoryWriter,
    ExtractionPayload
} from '../../contracts/workflows'
import { Time } from 'koishi'
import type { LivingMemoryRepository } from '../persistence/repository'
import { DEFAULT_MEMORY_IMPORTANCE } from '../memory/entry_fields'
import {
    createSyntheticSpeakerLabel,
    resolveScopeSpeakerKeys
} from '../memory/speaker_identity'
import { SerialTaskQueue } from '../shared/serial_task_queue'
import { summarizeError } from '../shared/utils'
import { LivingMemoryFactsCommittedError } from '../vector_index/errors'
import type { LivingMemoryLogger } from '../logging/logger'

type MemoryFactRepository = Pick<
    LivingMemoryRepository,
    | 'appendMemories'
    | 'registerMissingPresetSpeakers'
    | 'listActiveMemorySpeakerKeys'
    | 'listPresetSpeakers'
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
    implements
        ExtractionMemoryWriter,
        DreamMemoryRepository,
        DreamSpeakerCoverage
{
    private readonly queue = new SerialTaskQueue()

    constructor(
        private readonly repository: MemoryFactRepository,
        private readonly vectorIndex: MemoryIndexMutationSink,
        private readonly logger: LivingMemoryLogger
    ) {}

    /**
     * Dream 前置补齐：活跃记忆上的缺行键以合成标签补注册。必须在预设级
     * 队列内重读活跃键——队列外读到的键可能已被同预设清空删除，按陈旧
     * 键补行会在清空后的预设上留下孤儿注册行，listDistinctPresetIds 会
     * 把它重新列为存量预设。
     */
    async ensurePresetSpeakersCoverage(
        presetId: string
    ): Promise<PresetSpeakerRecord[]> {
        return this.runPresetMutation(presetId, async () => {
            const [activeKeys, registered] = await Promise.all([
                this.repository.listActiveMemorySpeakerKeys(presetId),
                this.repository.listPresetSpeakers(presetId)
            ])
            const registeredKeys = new Set(
                registered.map((speaker) => speaker.speakerKey)
            )
            const missing = activeKeys
                .filter((speakerKey) => !registeredKeys.has(speakerKey))
                .map((speakerKey) => ({
                    speakerKey,
                    speakerLabel: createSyntheticSpeakerLabel(speakerKey)
                }))
            if (missing.length === 0) {
                return registered
            }
            await this.repository.registerMissingPresetSpeakers(
                presetId,
                missing
            )
            return this.repository.listPresetSpeakers(presetId)
        })
    }

    async appendExtractedMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: AttributedMemoryItem[],
        sourceLabel: string,
        windowSpeakers: ExtractionPayload['speakers']
    ) {
        return this.runPresetMutation(scope.presetId, async () => {
            // 铸键不变量：窗口说话人的注册与记忆追加必须在同一预设级队列
            // 操作内完成——注册若在队列外先行提交，同预设清空可插入两步
            // 之间，清掉注册行后再追加记忆，缺行崩溃面回归。两步仍分属
            // 两个事务：注册行先行而记忆未落的中间态是无害闲置行（工程
            // 约束 8）；注册失败时记忆尚未落库，fail-streak 重试不会重复
            // 写记忆。
            if (windowSpeakers.length > 0) {
                await this.repository.registerMissingPresetSpeakers(
                    scope.presetId,
                    windowSpeakers
                )
            }
            const records = await this.repository.appendMemories(
                scope,
                sourceOriginMessages,
                extracted,
                sourceLabel
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
            // 仅 createMemory 预检；appendExtractedMemories 的提取窗口
            // 过期即失，宁可落库后进入 dirty 由对账修复，也不能丢轮次。
            this.vectorIndex.assertPresetReady(scope.presetId)
            // 显式键优先，省略时沿用仓储侧同一条 scope 推导规则，注册
            // 与落库共用一组键。
            const effectiveSpeakerKeys =
                speakerKeys ?? resolveScopeSpeakerKeys(scope)
            await this.registerCallerSpeakerKeys(
                scope.presetId,
                effectiveSpeakerKeys
            )
            const record = await this.repository.createMemory(
                scope,
                input,
                effectiveSpeakerKeys
            )
            await this.applyCommittedMutation({
                presetId: record.presetId,
                upserts: [this.upsert(record, 'replace')],
                deletes: []
            })
            return record
        })
    }

    async updateMemory(id: string, patch: MemoryUpdatePatch) {
        const current = await this.repository.getEntryById(id)
        if (current === undefined) {
            return null
        }
        return this.runPresetMutation(current.presetId, async () => {
            // 队列外读到的条目可能已被同预设清空/删除：进队列后重读确认，
            // 否则会为已不存在的目标补注册行，清空后的预设因孤儿注册行
            // 被 listDistinctPresetIds 重新列为存量。
            if ((await this.repository.getEntryById(id)) === undefined) {
                return null
            }
            await this.registerCallerSpeakerKeys(
                current.presetId,
                patch.speakerKeys
            )
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

    /**
     * 铸键不变量：create/update 落库的键（显式传入或 scope 默认推导）不
     * 经过提取窗口映射，RPC 面只有键没有昵称，落库前以合成标签补齐缺失
     * 行。与记忆写入同在预设级队列操作内、分属两个事务，依据同
     * appendExtractedMemories。
     */
    private async registerCallerSpeakerKeys(
        presetId: string,
        speakerKeys: readonly string[] | undefined
    ) {
        if (speakerKeys == null || speakerKeys.length === 0) {
            return
        }
        await this.repository.registerMissingPresetSpeakers(
            presetId,
            speakerKeys.map((speakerKey) => ({
                speakerKey,
                speakerLabel: createSyntheticSpeakerLabel(speakerKey)
            }))
        )
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
                const records = await this.repository.archiveActiveEntries(
                    presetId,
                    uniqueIds.slice(start, start + MEMORY_DELETE_BATCH_SIZE)
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
            sourceConversationId: record.sourceConversationId,
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
