import type { HumanMessage } from '@langchain/core/messages'
import { Context, Service, Time } from 'koishi'
import { LivingMemoryDreamService } from '../workflows/dream'
import { LivingMemoryDreamWorkerClient } from '../workflows/dream/worker/client'
import { LivingMemoryIncrementalDreamService } from '../workflows/dream/incremental'
import { LivingMemoryDreamJobRunner } from '../workflows/dream/job_runner'
import { LivingMemoryExtractor } from '../workflows/extraction/extractor'
import { LivingMemoryMessageFormatter } from '../transcript/message_formatter'
import { LivingMemoryRecallQueryBuilder } from '../workflows/recall/query_builder'
import { LivingMemoryRepository } from '../persistence/repository'
import { LivingMemoryRetriever } from '../workflows/recall/retriever'
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
    LivingMemoryCompletedRound,
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    LivingMemoryTranscriptMessage,
    MemoryMutationInput,
    MemoryScope
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

export type { QueueExtractionOptions } from '../memory/helpers'

export class ChatLunaLivingMemoryService extends Service<LivingMemoryConfig> {
    readonly memoryLogger: LivingMemoryLogger
    private readonly repository: LivingMemoryRepository
    private readonly snapshotCache: LivingMemorySnapshotCache
    private readonly recallCoordinator: LivingMemoryRecallCoordinator
    private readonly extractionCoordinator: LivingMemoryExtractionCoordinator
    private readonly dreamCoordinator: LivingMemoryDreamCoordinator
    private readonly presetCatalog: LivingMemoryPresetCatalog
    private readonly userProfiles: LivingMemoryUserProfileService
    private readonly searchEngine: LivingMemoryEmbeddingSearchEngine
    private readonly vectorIndex: LivingMemoryVectorIndexService
    private readonly dreamWorker: LivingMemoryDreamWorkerClient
    private readonly mutations: LivingMemoryMutationService

    constructor(
        public readonly ctx: Context,
        public config: LivingMemoryConfig
    ) {
        super(ctx, 'chatluna_living_memory', true)
        this.memoryLogger = new LivingMemoryLogger(
            ctx.logger('chatluna-livingmemory'),
            () => this.config.debug
        )

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
        const retriever = new LivingMemoryRetriever(
            ctx,
            config,
            this.repository,
            this.vectorIndex,
            this.memoryLogger
        )
        const extractor = new LivingMemoryExtractor(ctx, config.mainModel)
        const formatter = new LivingMemoryMessageFormatter()
        const recallQuery = new LivingMemoryRecallQueryBuilder(ctx, config)
        this.searchEngine = new LivingMemoryEmbeddingSearchEngine(
            config,
            this.repository,
            this.vectorIndex
        )
        const agenticRecall = new LivingMemoryAgenticRecallExecutor(
            ctx,
            config,
            this.searchEngine,
            this.memoryLogger
        )
        this.userProfiles = new LivingMemoryUserProfileService(
            ctx,
            config,
            this.repository,
            this.memoryLogger
        )
        const dream = new LivingMemoryDreamService(
            ctx,
            config,
            this.repository,
            this.mutations,
            this.vectorIndex,
            this.dreamWorker,
            this.memoryLogger
        )
        const incrementalDream = new LivingMemoryIncrementalDreamService(
            ctx,
            config,
            this.repository,
            this.mutations,
            this.vectorIndex
        )

        const jobTracker = new LivingMemoryJobTracker(this.repository)
        this.snapshotCache = new LivingMemorySnapshotCache(this.repository)
        const dreamJobRunner = new LivingMemoryDreamJobRunner(
            dream,
            incrementalDream,
            this.snapshotCache,
            jobTracker,
            this.memoryLogger
        )
        this.recallCoordinator = new LivingMemoryRecallCoordinator(
            config,
            this.repository,
            recallQuery,
            retriever,
            agenticRecall,
            this.snapshotCache,
            this.memoryLogger
        )
        this.dreamCoordinator = new LivingMemoryDreamCoordinator(
            config,
            dreamJobRunner,
            this.repository,
            this.memoryLogger
        )
        this.extractionCoordinator = new LivingMemoryExtractionCoordinator(
            config,
            this.repository,
            this.mutations,
            formatter,
            extractor,
            (presetId) => this.queueAutoDreamIfThresholdReached(presetId),
            this.memoryLogger
        )
        this.presetCatalog = new LivingMemoryPresetCatalog(
            ctx,
            this.repository,
            this.memoryLogger
        )

        this.repository.defineTables()
        ctx.setInterval(() => {
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
    }

    protected async stop() {
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

    async queueExtraction(
        scope: MemoryScope,
        completedRound: LivingMemoryCompletedRound,
        options: QueueExtractionOptions
    ) {
        await this.extractionCoordinator.queue(scope, completedRound, options)
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
    }

    async listPresetIds(): Promise<string[]> {
        return await this.presetCatalog.list()
    }

    async listMemories(query: MemoryListQuery) {
        const items = await this.repository.listEntriesByPreset(query.presetId)
        return filterMemoryList(items, query)
    }

    async listMemoryIds(filter: MemoryListFilter) {
        const items = await this.repository.listEntriesByPreset(filter.presetId)
        return filterMemoryIds(items, filter)
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

    async searchMemories(presetId: string, input: LivingMemorySearchInput) {
        return await this.searchEngine.searchMemories(presetId, input)
    }

    async getMemorySourceMessages(presetId: string, memoryIds: string[]) {
        return await loadMemorySourceMessages(
            this.repository,
            presetId,
            memoryIds
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

    async updateMemory(memoryId: string, patch: Partial<MemoryMutationInput>) {
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
}
