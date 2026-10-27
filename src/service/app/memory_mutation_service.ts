import { MemoryInputError } from '../memory/errors'
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
    MemoryIndexMutationBatch,
    MemoryIndexMutationSink,
    MemoryIndexUpsert
} from '../../contracts/vector_index'
import type {
    AttributedMemoryItem,
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
import { formatErrorDetails } from '../shared/utils'
import { LivingMemoryFactsCommittedError } from '../vector_index/errors'
import { formatLogScope, type LivingMemoryLogger } from '../logging/logger'

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
    | 'archiveActiveEntries'
    | 'mergeMemories'
    | 'splitMemory'
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

export class LivingMemoryMutationService implements ExtractionMemoryWriter {
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
            await this.syncCommittedMutationToIndex({
                presetId: scope.presetId,
                upserts: records.map((record) =>
                    this.buildIndexUpsert(record, 'replace')
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
            await this.syncCommittedMutationToIndex({
                presetId: record.presetId,
                upserts: [this.buildIndexUpsert(record, 'replace')],
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
            const latest = await this.repository.getEntryById(id)
            if (latest === undefined) {
                return null
            }
            return this.persistMemoryUpdate(latest, patch)
        })
    }

    async updateActiveMemory(
        presetId: string,
        id: string,
        patch: Omit<MemoryUpdatePatch, 'status'>
    ): Promise<MemoryEntryRecord | null> {
        return this.runPresetMutation(presetId, async () => {
            const current = await this.repository.getEntryById(id)
            if (
                current === undefined ||
                current.presetId !== presetId ||
                current.status !== 'active'
            ) {
                return null
            }
            const result = await this.persistMemoryUpdate(
                current,
                patch
            )
            return result?.record ?? null
        })
    }

    // 调用方已持有预设队列并重读目标，此处只复用写入步骤，不再次入队。
    private async persistMemoryUpdate(
        current: MemoryEntryRecord,
        patch: MemoryUpdatePatch
    ) {
        await this.registerCallerSpeakerKeys(
            current.presetId,
            patch.speakerKeys
        )
        const result = await this.repository.updateMemory(
            current.id,
            patch
        )
        if (result === null) {
            return null
        }
        await this.syncCommittedMutationToIndex({
            presetId: result.record.presetId,
            upserts: [
                this.buildIndexUpsert(
                    result.record,
                    result.contentChanged ? 'replace' : 'preserve'
                )
            ],
            deletes: []
        })
        return result
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

    async archiveActiveMemories(presetId: string, ids: string[]) {
        const uniqueIds = [...new Set(ids)]
        if (uniqueIds.length === 0) {
            return { archived: 0 }
        }
        return this.runPresetMutation(presetId, async () => {
            let snapshotsCleared = false
            const archived = await this.runBatchedMutation(
                uniqueIds,
                async (batchIds) => {
                    const records = await this.repository.archiveActiveEntries(
                        presetId,
                        batchIds
                    )
                    if (records.length === 0) {
                        return 0
                    }
                    if (!snapshotsCleared) {
                        await this.repository.deleteSnapshotsByPreset(presetId)
                        snapshotsCleared = true
                    }
                    await this.syncCommittedMutationToIndex({
                        presetId,
                        upserts: records.map((record) =>
                            this.buildIndexUpsert(record, 'preserve')
                        ),
                        deletes: []
                    })
                    return records.length
                }
            )
            return { archived }
        })
    }

    async splitActiveMemory(
        presetId: string,
        sourceMemoryId: string,
        memories: AttributedMemoryItem[]
    ) {
        if (memories.length < 2) {
            throw new MemoryInputError('拆分结果至少需要两条记忆。')
        }
        return this.runPresetMutation(presetId, async () => {
            const source = await this.repository.getEntryById(sourceMemoryId)
            if (
                source === undefined ||
                source.presetId !== presetId ||
                source.status !== 'active'
            ) {
                throw new MemoryInputError(
                    `不存在 ID 为 ${sourceMemoryId} 的记忆，请重新查明记忆 ID 后再调用。`
                )
            }
            await this.registerCallerSpeakerKeys(
                presetId,
                memories.flatMap((memory) => memory.speakerKeys)
            )
            const result = await this.repository.splitMemory(
                presetId,
                sourceMemoryId,
                memories
            )
            const warnings = await this.syncReplacementMemoriesToIndex(
                presetId,
                result.memories,
                [result.archivedSource],
                '拆分'
            )
            return { memories: result.memories, warnings }
        })
    }

    async mergeActiveMemories(
        presetId: string,
        sourceMemoryIds: string[],
        memory: AttributedMemoryItem
    ) {
        const sourceIds = new Set(sourceMemoryIds)
        if (sourceIds.size < 2 || sourceIds.size !== sourceMemoryIds.length) {
            throw new MemoryInputError(
                '合并来源至少需要两条记忆，ID 不得重复。'
            )
        }
        return this.runPresetMutation(presetId, async () => {
            const entries = await this.repository.getEntriesByPresetAndIds(
                presetId,
                sourceMemoryIds
            )
            const entryById = new Map(entries.map((entry) => [entry.id, entry]))
            for (const id of sourceMemoryIds) {
                const entry = entryById.get(id)
                if (entry === undefined || entry.status !== 'active') {
                    throw new MemoryInputError(
                        `不存在 ID 为 ${id} 的记忆，请重新查明记忆 ID 后再调用。`
                    )
                }
            }
            await this.registerCallerSpeakerKeys(presetId, memory.speakerKeys)
            const result = await this.repository.mergeMemories(
                presetId,
                sourceMemoryIds,
                memory
            )
            const warnings = await this.syncReplacementMemoriesToIndex(
                presetId,
                [result.memory],
                result.archivedSources,
                '合并'
            )
            return { memory: result.memory, warnings }
        })
    }

    private async syncReplacementMemoriesToIndex(
        presetId: string,
        created: MemoryEntryRecord[],
        archived: MemoryEntryRecord[],
        operation: '合并' | '拆分'
    ): Promise<string[]> {
        try {
            await this.syncCommittedMutationToIndex({
                presetId,
                upserts: [
                    ...created.map((record) =>
                        this.buildIndexUpsert(record, 'replace')
                    ),
                    ...archived.map((record) =>
                        this.buildIndexUpsert(record, 'preserve')
                    )
                ],
                deletes: []
            })
            return []
        } catch (error) {
            if (!(error instanceof LivingMemoryFactsCommittedError)) throw error
            // 已提交的新 ID 随警告返回，供调用方继续使用。
            return [
                `记忆已${operation}，但向量索引同步失败，已调度后台自动对账：${error.message}`
            ]
        }
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
            await this.syncCommittedMutationToIndex({
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
            const deleted = await this.runBatchedMutation(
                uniqueIds,
                async (batchIds) => {
                    // 先按存在性与 preset 归属过滤：并发已删除或跨 preset
                    // 的 id 幂等跳过，不中断整批。
                    const records =
                        await this.repository.getEntriesByPresetAndIds(
                            presetId,
                            batchIds
                        )
                    if (records.length === 0) {
                        return 0
                    }
                    const validIds = records.map((record) => record.id)
                    await this.repository.deleteEntries(presetId, validIds)
                    await this.syncCommittedMutationToIndex({
                        presetId,
                        upserts: [],
                        deletes: validIds.map((id) => ({ id, presetId }))
                    })
                    return validIds.length
                }
            )
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

            const deleted = await this.runBatchedMutation(
                expiredIds,
                async (batchIds) => {
                    await this.repository.deleteEntries(presetId, batchIds)
                    await this.syncCommittedMutationToIndex({
                        presetId,
                        upserts: [],
                        deletes: batchIds.map((id) => ({ id, presetId }))
                    })
                    return batchIds.length
                }
            )
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

    private async syncCommittedMutationToIndex(
        batch: MemoryIndexMutationBatch
    ) {
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
                this.logger.summary(
                    '索引对账调度失败',
                    formatLogScope({ presetId }),
                    'warn',
                    error
                )
            })
    }

    /**
     * 按 MEMORY_DELETE_BATCH_SIZE 将 id 切片，逐批执行 applyBatch 并累加其
     * 返回的处理条数。批大小、切片与计数的单点：三处批量归档/删除只描述
     * 每批做什么，SQL $in 规模与索引同步批次的约束集中在此维护。
     */
    private async runBatchedMutation(
        ids: string[],
        applyBatch: (batchIds: string[]) => Promise<number>
    ): Promise<number> {
        let processed = 0
        for (
            let start = 0;
            start < ids.length;
            start += MEMORY_DELETE_BATCH_SIZE
        ) {
            processed += await applyBatch(
                ids.slice(start, start + MEMORY_DELETE_BATCH_SIZE)
            )
        }
        return processed
    }

    private runPresetMutation<T>(presetId: string, task: () => Promise<T>) {
        return this.queue.run(presetId, async () => {
            await this.vectorIndex.waitForMaintenance()
            return task()
        })
    }

    private buildIndexUpsert(
        record: MemoryEntryRecord,
        vectorAction: MemoryIndexUpsert['vectorAction']
    ): MemoryIndexUpsert {
        return {
            document: {
                id: record.id,
                presetId: record.presetId,
                sourceConversationId: record.sourceConversationId,
                status: record.status,
                type: record.type,
                content: record.content,
                keywords: record.keywords,
                updatedAt: record.updatedAt
            },
            vectorAction
        }
    }

    private factsCommittedError(presetId: string, error: unknown) {
        return new LivingMemoryFactsCommittedError(
            `memory facts committed but vector index synchronization failed: ` +
                `preset=${presetId}: ${formatErrorDetails(error)}`,
            { cause: error }
        )
    }
}
