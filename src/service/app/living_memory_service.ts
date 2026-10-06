import type { HumanMessage } from '@langchain/core/messages'
import { Context, Service, Time } from 'koishi'
import { LivingMemoryDreamService } from '../workflows/dream'
import { LivingMemoryDreamWorkerClient } from '../workflows/dream/worker/client'
import { LivingMemoryIncrementalDreamService } from '../workflows/dream/incremental'
import { LivingMemoryDreamJobRunner } from '../workflows/dream/job_runner'
import { LivingMemoryExtractor } from '../workflows/extraction/extractor'
import { LivingMemoryMessageFormatter } from '../transcript/message_formatter'
import { LivingMemoryRepository } from '../persistence/repository'
import {
    LivingMemoryUserProfileService,
    normalizeManualUserProfileContent
} from '../user_profile'
import {
    createUserProfileSpeakerKey,
    normalizeUserProfileSpeakerLabel
} from '../memory/speaker_identity'
import { toNonEmptyString } from '../shared/utils'
import {
    filterJobList,
    filterMemoryIds,
    filterMemoryList,
    filterUserProfileList
} from '../../query'
import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    LivingMemoryTranscriptMessage,
    MemoryMutationInput,
    MemoryScope,
    MemoryUpdatePatch,
    PresetPersonaCardInfo
} from '../../contracts/memory'
import type {
    JobListQuery,
    MemoryListFilter,
    MemoryListQuery,
    SnapshotListQuery,
    UserProfileListQuery
} from '../../contracts/rpc'
import type {
    DreamTriggerResult,
    LivingMemoryConfig,
    MemoryConfigWarning,
    MemoryServiceStatus
} from '../../contracts/workflows'
import { LivingMemoryDreamCoordinator } from '../workflows/dream/coordinator'
import { LivingMemoryExtractionCoordinator } from '../workflows/extraction/coordinator'
import { LivingMemoryJobTracker } from '../workflows/job_tracker'
import { LivingMemoryPresetCatalog } from '../memory/preset_catalog'
import { LivingMemoryPresetPersonaService } from '../memory/preset_persona'
import type { QueueExtractionOptions } from '../memory/helpers'
import { LivingMemoryRecallCoordinator } from '../workflows/recall/coordinator'
import { LivingMemorySnapshotCache } from '../memory/snapshot/snapshot_cache'
import { LivingMemoryVectorIndexService } from '../vector_index/service'
import { LivingMemoryMutationService } from './memory_mutation_service'
import { LivingMemoryAgenticRecallExecutor } from '../workflows/recall/agentic_recall'
import { LivingMemoryEmbeddingSearchEngine } from '../workflows/recall/embedding_search_engine'
import {
    createLivingMemoryServiceStatus,
    validateLivingMemoryConfig
} from './config_status'
import {
    createLivingMemoryScope,
    type CreateLivingMemoryScopeOptions
} from './scope'
import {
    hydrateLivingMemoryPromptSections,
    hydrateLivingMemoryPromptVariable,
    type LivingMemoryPromptSectionsOptions
} from './prompt_hydration'
import {
    listResolvedMemorySnapshots,
    loadMemorySourceMessages
} from './query_projections'
import { LivingMemoryLogger } from '../logging/logger'
import { MessageLogRegistry } from '../transcript/message_log/message_log_registry'

export type { QueueExtractionOptions } from '../memory/helpers'

export class ChatLunaLivingMemoryService extends Service<LivingMemoryConfig> {
    readonly memoryLogger: LivingMemoryLogger
    /** 会话消息日志：召回与提取共用的唯一消息历史视界。 */
    readonly messageLog: MessageLogRegistry
    private readonly repository: LivingMemoryRepository
    private readonly snapshotCache: LivingMemorySnapshotCache
    private readonly recallCoordinator: LivingMemoryRecallCoordinator
    private readonly extractionCoordinator: LivingMemoryExtractionCoordinator
    private readonly dreamCoordinator: LivingMemoryDreamCoordinator
    private readonly presetCatalog: LivingMemoryPresetCatalog
    private readonly userProfiles: LivingMemoryUserProfileService
    private readonly presetPersona: LivingMemoryPresetPersonaService
    private readonly searchEngine: LivingMemoryEmbeddingSearchEngine
    private readonly vectorIndex: LivingMemoryVectorIndexService
    private readonly dreamWorker: LivingMemoryDreamWorkerClient
    private readonly mutations: LivingMemoryMutationService
    private archivedMemoryCleanup = Promise.resolve()

    constructor(
        public readonly ctx: Context,
        public config: LivingMemoryConfig
    ) {
        super(ctx, 'chatluna_living_memory', true)
        this.memoryLogger = new LivingMemoryLogger(
            ctx.logger('chatluna-livingmemory'),
            () => this.config.debug
        )
        this.messageLog = new MessageLogRegistry()
        ctx.on('dispose', () => this.messageLog.dispose())

        this.repository = new LivingMemoryRepository(ctx)
        this.vectorIndex = new LivingMemoryVectorIndexService(
            ctx,
            config,
            this.repository,
            this.memoryLogger
        )
        this.dreamWorker = new LivingMemoryDreamWorkerClient({
            onFailure: (error) =>
                this.memoryLogger.error(
                    'dream.worker.failed',
                    { workflow: 'dream', operation: 'dream-worker' },
                    error
                )
        })
        this.mutations = new LivingMemoryMutationService(
            this.repository,
            this.vectorIndex,
            this.memoryLogger
        )
        this.searchEngine = new LivingMemoryEmbeddingSearchEngine(
            ctx,
            config,
            this.repository,
            this.vectorIndex,
            this.memoryLogger
        )
        this.snapshotCache = new LivingMemorySnapshotCache(this.repository)
        this.presetCatalog = new LivingMemoryPresetCatalog(
            ctx,
            this.repository,
            this.memoryLogger
        )
        this.presetPersona = new LivingMemoryPresetPersonaService(
            ctx,
            config,
            this.repository,
            this.memoryLogger
        )
        this.userProfiles = new LivingMemoryUserProfileService(
            config,
            this.repository,
            this.memoryLogger,
            this.presetPersona
        )

        this.recallCoordinator = this.createRecallCoordinator(config)
        this.dreamCoordinator = this.createDreamCoordinator(config)
        this.extractionCoordinator = this.createExtractionCoordinator(config)

        this.repository.defineTables()
        this.scheduleDailyMaintenance()
    }

    private createRecallCoordinator(
        config: LivingMemoryConfig
    ): LivingMemoryRecallCoordinator {
        const agenticRecall = new LivingMemoryAgenticRecallExecutor(
            this.ctx,
            config,
            this.searchEngine,
            this.memoryLogger
        )
        return new LivingMemoryRecallCoordinator(
            config,
            this.messageLog,
            this.repository,
            agenticRecall,
            this.snapshotCache,
            this.memoryLogger
        )
    }

    private createDreamCoordinator(
        config: LivingMemoryConfig
    ): LivingMemoryDreamCoordinator {
        const dream = new LivingMemoryDreamService(
            this.ctx,
            config,
            this.repository,
            this.mutations,
            this.mutations,
            this.vectorIndex,
            this.dreamWorker,
            this.memoryLogger,
            this.userProfiles,
            this.presetPersona
        )
        const incrementalDream = new LivingMemoryIncrementalDreamService(
            this.ctx,
            config,
            this.repository,
            this.mutations,
            this.mutations,
            this.vectorIndex,
            this.userProfiles,
            this.presetPersona
        )
        const jobTracker = new LivingMemoryJobTracker(this.repository)
        const dreamJobRunner = new LivingMemoryDreamJobRunner(
            dream,
            incrementalDream,
            this.snapshotCache,
            jobTracker,
            this.memoryLogger
        )
        return new LivingMemoryDreamCoordinator(
            config,
            dreamJobRunner,
            this.repository,
            this.memoryLogger
        )
    }

    private createExtractionCoordinator(
        config: LivingMemoryConfig
    ): LivingMemoryExtractionCoordinator {
        const extractor = new LivingMemoryExtractor(this.ctx, config.mainModel)
        const formatter = new LivingMemoryMessageFormatter()
        return new LivingMemoryExtractionCoordinator(
            config,
            this.messageLog,
            this.repository,
            this.mutations,
            formatter,
            extractor,
            this.presetPersona,
            (presetId) => this.queueAutoDreamIfThresholdReached(presetId),
            this.memoryLogger
        )
    }

    /** 每日维护：清理过期任务，并调度过期归档记忆的衰减清理。 */
    private scheduleDailyMaintenance() {
        this.ctx.setInterval(() => {
            this.cleanupStaleJobs().catch((error) => {
                this.memoryLogger.warn(
                    'maintenance.cleanup.failed',
                    {
                        workflow: 'maintenance',
                        operation: 'cleanup-stale-jobs',
                        trigger: 'scheduled'
                    },
                    error
                )
            })
            this.queueExpiredArchivedMemoryCleanup('scheduled')
        }, Time.day)
    }

    protected async start() {
        const repaired = await this.repository.migrateMemorySourceOriginsArray()
        if (repaired > 0) {
            this.memoryLogger.info('startup.migration.completed', {
                workflow: 'maintenance',
                operation: 'repair-source-origins',
                repaired
            })
        }
        const clearedWebuiKeys =
            await this.repository.migrateWebuiSourceConversationKeys()
        if (clearedWebuiKeys > 0) {
            this.memoryLogger.info('startup.migration.completed', {
                workflow: 'maintenance',
                operation: 'clear-webui-source-conversation',
                cleared: clearedWebuiKeys
            })
        }
        const indexed = await this.repository.migrateActiveMemorySpeakers()
        if (indexed > 0) {
            this.memoryLogger.info('startup.migration.completed', {
                workflow: 'maintenance',
                operation: 'index-active-memory-speakers',
                indexed
            })
        }
        const droppedIndexes = await this.repository.dropLegacyPendingIndexes()
        if (droppedIndexes.length > 0) {
            this.memoryLogger.info('startup.migration.completed', {
                workflow: 'maintenance',
                operation: 'drop-legacy-pending-index',
                dropped: droppedIndexes
            })
        }

        try {
            const recovered =
                await this.repository.markStaleRunningJobsAsFailed(
                    {},
                    'recovered: service restarted while job was running'
                )
            if (recovered.length > 0) {
                this.memoryLogger.info('startup.recovery.completed', {
                    workflow: 'maintenance',
                    operation: 'recover-stale-jobs',
                    recovered: recovered.length
                })
            }
        } catch (error) {
            this.memoryLogger.warn(
                'startup.recovery.failed',
                {
                    workflow: 'maintenance',
                    operation: 'recover-stale-jobs',
                    trigger: 'startup'
                },
                error
            )
        }

        for (const warning of this.validateConfig()) {
            this.memoryLogger.warn('config.warning', {
                workflow: 'startup',
                code: warning.code,
                message: warning.message
            })
        }

        await this.vectorIndex.start()
        try {
            await this.dreamWorker.start()
        } catch (error) {
            try {
                await this.dreamWorker.stop()
            } finally {
                await this.vectorIndex.stop()
            }
            throw error
        }
        this.queueExpiredArchivedMemoryCleanup('startup')
        await this.archivedMemoryCleanup
    }

    protected async stop() {
        await this.archivedMemoryCleanup
        this.vectorIndex.beginStop()
        try {
            await this.dreamWorker.stop()
        } finally {
            await this.vectorIndex.stop()
        }
    }

    validateConfig(): MemoryConfigWarning[] {
        return validateLivingMemoryConfig(this.config)
    }

    getStatus(): MemoryServiceStatus {
        return createLivingMemoryServiceStatus(
            this.config,
            this.vectorIndex.getStatus()
        )
    }

    private queueAutoDreamIfThresholdReached(presetId: string) {
        this.dreamCoordinator
            .queueAutoIfThresholdReached(presetId)
            .catch((error) => {
                this.memoryLogger.warn(
                    'dream.queue.failed',
                    {
                        workflow: 'dream',
                        operation: 'queue-automatic',
                        presetId,
                        trigger: 'memory-threshold'
                    },
                    error
                )
            })
    }

    resolvePresetId(message: HumanMessage, fallbackPresetId?: string) {
        const presetFromMessage = message.additional_kwargs?.preset
        if (
            typeof presetFromMessage === 'string' &&
            presetFromMessage.length > 0
        ) {
            return presetFromMessage
        }

        if (fallbackPresetId && fallbackPresetId.length > 0) {
            return fallbackPresetId
        }

        return null
    }

    createScope(
        conversationId: string,
        presetId: string,
        userId?: string,
        channelId?: string,
        options: CreateLivingMemoryScopeOptions = {}
    ): MemoryScope {
        return createLivingMemoryScope(
            conversationId,
            presetId,
            userId,
            channelId,
            options
        )
    }

    async recordPresetSpeaker(
        scope: Pick<
            MemoryScope,
            'presetId' | 'speakerId' | 'userId' | 'platform'
        >,
        speakerLabel: string
    ) {
        const label = normalizeUserProfileSpeakerLabel(speakerLabel)
        const speakerId =
            toNonEmptyString(scope.speakerId) ?? toNonEmptyString(scope.userId)
        const platform = toNonEmptyString(scope.platform)
        if (label.length === 0 || speakerId == null || platform == null) {
            throw new Error('stable user profile identity is missing')
        }
        const speakerKey = createUserProfileSpeakerKey(platform, speakerId)

        await this.repository.reconcilePresetSpeaker({
            presetId: scope.presetId,
            speakerKey,
            speakerLabel: label,
            speakerId,
            platform
        })
    }

    async hydratePromptVariable(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        return await hydrateLivingMemoryPromptVariable(
            { snapshotCache: this.snapshotCache },
            scope
        )
    }

    async hydratePromptSections(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>,
        options: LivingMemoryPromptSectionsOptions = {}
    ) {
        return await hydrateLivingMemoryPromptSections(
            {
                snapshotCache: this.snapshotCache,
                userProfiles: this.userProfiles
            },
            scope,
            options
        )
    }

    async queueRecall(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>
    ) {
        await this.recallCoordinator.queue(
            scope,
            currentMessage,
            loadHistoryMessages
        )
    }

    async queueExtraction(scope: MemoryScope, options: QueueExtractionOptions) {
        await this.extractionCoordinator.queue(scope, options)
    }

    clearExtractionState() {
        this.extractionCoordinator.clearAll()
    }

    clearRecallState() {
        this.recallCoordinator.clearAll()
    }

    async cleanupConversation(conversationId: string) {
        await this.repository.deleteSnapshotsByConversation(conversationId)
        this.snapshotCache.clearByConversation(conversationId)
        this.recallCoordinator.clearByConversation(conversationId)
        this.extractionCoordinator.clearByConversation(conversationId)
        this.messageLog.clear(conversationId)
    }

    async listPresetIds(): Promise<string[]> {
        return await this.presetCatalog.list()
    }

    /**
     * 读取预设人设卡片正文，供外部插件使用：已落库时返回卡片，否则返回预设
     * system 部分原文。只读，不调模型、不落库。
     */
    resolvePresetPersona(presetId: string): Promise<string> {
        return this.presetPersona.readCard(presetId)
    }

    /**
     * 读取单个预设人设卡片（只读视图，不含模型调用）。外部插件需要卡片正文时
     * 用 `resolvePresetPersona`，需要异常提示或落库时间时用这里。
     */
    async getPresetPersonaCard(
        presetId: string
    ): Promise<PresetPersonaCardInfo | undefined> {
        return await this.presetPersona.getCard(presetId)
    }

    /** 列出全部预设人设卡片及其异常提示，供 Console 展示与外部插件读取。 */
    async listPresetPersonas(): Promise<PresetPersonaCardInfo[]> {
        return await this.presetPersona.listCards()
    }

    /** 保存手工编辑的预设人设卡片；此后不再被自动覆盖。 */
    async savePresetPersonaCard(presetId: string, card: string) {
        await this.presetPersona.saveManualCard(presetId, card)
    }

    /** 丢弃手工卡片并按当前预设原文重新生成。 */
    async resetPresetPersonaCard(presetId: string) {
        await this.presetPersona.resetCard(presetId)
    }

    async listMemories(query: MemoryListQuery) {
        const items = await this.repository.listEntriesByPreset(query.presetId)
        return filterMemoryList(items, query)
    }

    async listMemoryIds(filter: MemoryListFilter) {
        const items = await this.repository.listEntriesByPreset(filter.presetId)
        return filterMemoryIds(items, filter)
    }

    async findActiveMemoryIdsByText(presetId: string, text: string) {
        const query = text.toLowerCase()
        return (await this.repository.listEntriesByPreset(presetId))
            .filter(
                (memory) =>
                    memory.status === 'active' &&
                    (memory.content.toLowerCase().includes(query) ||
                        memory.summary?.toLowerCase().includes(query) ===
                            true ||
                        memory.keywords.some((keyword) =>
                            keyword.toLowerCase().includes(query)
                        ))
            )
            .map((memory) => memory.id)
    }

    async findActiveMemoryIdsByUser(
        presetId: string,
        platform: string,
        userId: string
    ) {
        const speakerKey = createUserProfileSpeakerKey(platform, userId)
        return (
            await this.repository.listActiveMemorySpeakerLinks(presetId, [
                speakerKey
            ])
        ).map((link) => link.memoryId)
    }

    async findUserProfileIdByUser(
        presetId: string,
        platform: string,
        userId: string
    ) {
        const speakerKey = createUserProfileSpeakerKey(platform, userId)
        return (
            await this.repository.listUserProfilesBySpeakerKeys(presetId, [
                speakerKey
            ])
        )[0]?.id
    }

    async archiveActiveMemories(presetId: string, ids: string[]) {
        try {
            return await this.mutations.archiveActiveMemories(presetId, ids)
        } finally {
            this.snapshotCache.clearByPreset(presetId)
        }
    }

    async getMemory(memoryId: string) {
        return await this.repository.getEntryById(memoryId)
    }

    async searchMemoriesDetailed(
        presetId: string,
        input: LivingMemorySearchInput
    ): Promise<LivingMemorySearchDetailedResult[]> {
        return await this.searchEngine.searchMemoriesDetailed(presetId, input)
    }

    async searchMemories(
        presetId: string,
        input: LivingMemorySearchInput,
        conversationId?: string
    ) {
        return await this.searchEngine.searchMemories(
            presetId,
            input,
            conversationId
        )
    }

    async getMemorySourceMessages(presetId: string, memoryId: string) {
        return await loadMemorySourceMessages(
            this.repository,
            presetId,
            memoryId
        )
    }

    async createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        speakerKeys?: string[]
    ) {
        const memory = await this.mutations.createMemory(
            scope,
            input,
            speakerKeys
        )
        this.queueAutoDreamIfThresholdReached(scope.presetId)
        return memory
    }

    async updateMemory(memoryId: string, patch: MemoryUpdatePatch) {
        await this.mutations.updateMemory(memoryId, patch)
    }

    async deleteMemory(memoryId: string) {
        await this.mutations.deleteMemory(memoryId)
    }

    async deleteMemories(presetId: string, ids: string[]) {
        return await this.mutations.deleteMemories(presetId, ids)
    }

    async deleteSnapshot(snapshotId: string) {
        const deleted = await this.repository.deleteSnapshot(snapshotId)
        if (deleted != null) {
            this.snapshotCache.clearByScope(deleted)
        }
    }

    async listSnapshots(query: SnapshotListQuery) {
        return await listResolvedMemorySnapshots(this.repository, query)
    }

    async listJobs(query: JobListQuery) {
        const items = await this.repository.listJobsByPreset(query.presetId)
        return filterJobList(items, query)
    }

    async listUserProfiles(query: UserProfileListQuery) {
        const items = await this.repository.listUserProfilesByPreset(
            query.presetId
        )
        return filterUserProfileList(items, query)
    }

    async listPresetSpeakers(presetId: string) {
        return await this.repository.listPresetSpeakers(presetId)
    }

    async deleteUserProfile(profileId: string) {
        await this.repository.deleteUserProfile(profileId)
    }

    async updateUserProfile(profileId: string, content: string) {
        await this.repository.updateUserProfileContent(
            profileId,
            normalizeManualUserProfileContent(content)
        )
    }

    async runDream(presetId: string): Promise<DreamTriggerResult> {
        this.vectorIndex.assertPresetReady(presetId)
        return this.dreamCoordinator.runManual(presetId)
    }

    async reconcileVectorIndex(presetId: string) {
        return await this.vectorIndex.reconcilePreset(
            presetId,
            'manual reconcile'
        )
    }

    rebuildVectorIndex() {
        this.vectorIndex.startRebuild('manual rebuild')
    }

    async restartVectorIndex() {
        await this.vectorIndex.restart()
    }

    async clearPresetData(presetId: string) {
        try {
            await this.mutations.clearPresetData(presetId)
            await this.presetPersona.clearCard(presetId)
        } finally {
            this.snapshotCache.clearByPreset(presetId)
        }
    }

    async exportPreset(presetId: string): Promise<LivingMemoryPresetExport> {
        return await this.repository.exportPresetData(presetId)
    }

    async importPreset(
        targetPresetId: string,
        data: LivingMemoryPresetExport
    ): Promise<LivingMemoryPresetImportResult> {
        try {
            return await this.mutations.importPreset(targetPresetId, data)
        } finally {
            this.snapshotCache.clearByPreset(targetPresetId)
        }
    }

    async cleanupStaleJobs(maxAge: number = Time.week) {
        await this.repository.removeExpiredJobs(new Date(Date.now() - maxAge))
    }

    private queueExpiredArchivedMemoryCleanup(
        trigger: 'startup' | 'scheduled'
    ) {
        this.archivedMemoryCleanup = this.archivedMemoryCleanup.then(() =>
            this.cleanupExpiredArchivedMemories(trigger)
        )
    }

    private async cleanupExpiredArchivedMemories(
        trigger: 'startup' | 'scheduled'
    ) {
        try {
            let deleted = 0
            const now = new Date()
            for (const presetId of await this.repository.listEntryPresetIds()) {
                const result =
                    await this.mutations.deleteExpiredArchivedMemories(
                        presetId,
                        now
                    )
                deleted += result.deleted
            }
            if (deleted > 0) {
                this.memoryLogger.info(
                    'maintenance.archive-cleanup.completed',
                    {
                        workflow: 'maintenance',
                        operation: 'cleanup-expired-archived-memories',
                        trigger,
                        deleted
                    }
                )
            }
        } catch (error) {
            this.memoryLogger.warn(
                'maintenance.cleanup.failed',
                {
                    workflow: 'maintenance',
                    operation: 'cleanup-expired-archived-memories',
                    trigger
                },
                error
            )
        }
    }
}
