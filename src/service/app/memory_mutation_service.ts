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
    DreamMemoryRepository,
    DreamMergeInput,
    ExtractedMemoryItem,
    ExtractionRepository
} from '../../contracts/workflows'
import type { LivingMemoryRepository } from '../persistence/repository'
import { PresetTaskQueue } from '../shared/preset_task_queue'
import { summarizeError } from '../shared/utils'
import { LivingMemoryFactsCommittedError } from '../vector_index/errors'

type MemoryFactRepository = Pick<
    LivingMemoryRepository,
    | 'appendMemories'
    | 'getEntryById'
    | 'createMemory'
    | 'updateMemory'
    | 'updateMemoryForDream'
    | 'setMemoryConsolidation'
    | 'applyDreamMerge'
    | 'deleteMemory'
    | 'clearAllByPreset'
    | 'importPresetData'
>

export class LivingMemoryMutationService
    implements ExtractionRepository, DreamMemoryRepository
{
    private readonly queue = new PresetTaskQueue()

    constructor(
        private readonly repository: MemoryFactRepository,
        private readonly vectorIndex: MemoryIndexMutationSink
    ) {}

    async appendMemories(
        scope: MemoryScope,
        sourceOriginMessages: MemorySourceMessage[],
        extracted: ExtractedMemoryItem[]
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

    async createMemory(scope: MemoryScope, input: MemoryMutationInput) {
        return this.runPresetMutation(scope.presetId, async () => {
            const record = await this.repository.createMemory(scope, input)
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
        patch: Partial<MemoryMutationInput>,
        isConsolidated: boolean
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
            const records = await this.repository.setMemoryConsolidation(
                presetId,
                ids,
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

    async applyDreamMerge(input: DreamMergeInput) {
        return this.runPresetMutation(input.presetId, async () => {
            const result = await this.repository.applyDreamMerge(input)
            const upserts = [
                this.upsert(
                    result.target,
                    this.vectorAction(result.targetContentChanged)
                ),
                ...result.archivedSources.map((source: any) =>
                    this.upsert(source, 'preserve')
                )
            ]
            await this.applyCommittedMutation({
                presetId: result.target.presetId,
                upserts,
                deletes: result.deletedSourceIds.map((id: string) => ({
                    id,
                    presetId: result.target.presetId
                }))
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
            throw this.factsCommittedError(batch.presetId, error)
        }
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
