import type { HumanMessage } from '@langchain/core/messages'
import { Context, Logger, Service, Time } from 'koishi'
import type { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { LivingMemoryDreamService } from '../dream'
import { LivingMemoryExtractor } from '../extractor'
import { LivingMemoryMessageFormatter } from '../message_formatter'
import { LivingMemoryRecallQueryBuilder } from '../recall_query'
import {
    type LivingMemorySearchOptions,
    searchLivingMemoryEntries
} from './search'
import { LivingMemoryRepository } from '../repository'
import { LivingMemoryRetriever } from '../retriever'
import {
    LivingMemoryUserProfileService,
    normalizeUserProfileSpeakerKey,
    normalizeUserProfileSpeakerLabel
} from '../user_profile'
import { isModelConfigured } from '../shared/utils'
import {
    filterJobList,
    filterMemoryList,
    filterSnapshotList,
    filterUserProfileList,
    type JobListQuery,
    type MemoryListQuery,
    type PageResult,
    type SnapshotListQuery,
    type UserProfileListQuery
} from '../../query'
import type {
    DreamTriggerResult,
    LivingMemoryConfig,
    LivingMemorySearchResult,
    LivingMemoryTranscriptMessage,
    MemoryConfigWarning,
    MemoryMutationInput,
    MemoryScope,
    MemoryServiceStatus,
    MemorySnapshotWithResolvedItems
} from '../../types'
import { LivingMemoryDreamCoordinator } from './dream_coordinator'
import { LivingMemoryExtractionCoordinator } from './extraction_coordinator'
import { LivingMemoryJobTracker } from './job_tracker'
import { LivingMemoryPresetCatalog } from './preset_catalog'
import { LivingMemoryRecallCoordinator } from './recall_coordinator'
import { LivingMemorySnapshotCache } from './snapshot_cache'
import { LivingMemoryAgenticRecallExecutor } from './agentic_recall'
import { isMemoryReferenceItem } from './snapshot_items'
import type { QueueExtractionOptions } from './helpers'

export type { QueueExtractionOptions } from './helpers'

export class ChatLunaLivingMemoryService extends Service<LivingMemoryConfig> {
    private readonly serviceLogger: Logger
    private readonly repository: LivingMemoryRepository
    private readonly snapshotCache: LivingMemorySnapshotCache
    private readonly recallCoordinator: LivingMemoryRecallCoordinator
    private readonly extractionCoordinator: LivingMemoryExtractionCoordinator
    private readonly dreamCoordinator: LivingMemoryDreamCoordinator
    private readonly presetCatalog: LivingMemoryPresetCatalog
    private readonly userProfiles: LivingMemoryUserProfileService

    constructor(
        public readonly ctx: Context,
        public config: LivingMemoryConfig
    ) {
        super(ctx, 'chatluna_living_memory', true)
        this.serviceLogger = ctx.logger('chatluna-livingmemory')
        const debug = (message: string) => this.debug(message)

        this.repository = new LivingMemoryRepository(ctx)
        const retriever = new LivingMemoryRetriever(
            ctx,
            config,
            this.repository
        )
        const extractor = new LivingMemoryExtractor(ctx, config.extractModel)
        const formatter = new LivingMemoryMessageFormatter()
        const recallQuery = new LivingMemoryRecallQueryBuilder(ctx, config)
        const agenticRecall = new LivingMemoryAgenticRecallExecutor(
            ctx,
            config,
            debug
        )
        this.userProfiles = new LivingMemoryUserProfileService(
            ctx,
            config,
            this.repository,
            debug
        )
        const dream = new LivingMemoryDreamService(
            ctx,
            config,
            this.repository,
            debug
        )

        const jobTracker = new LivingMemoryJobTracker(this.repository)
        this.snapshotCache = new LivingMemorySnapshotCache(this.repository)
        this.recallCoordinator = new LivingMemoryRecallCoordinator(
            config,
            this.repository,
            recallQuery,
            retriever,
            agenticRecall,
            this.snapshotCache,
            jobTracker,
            this.serviceLogger,
            debug
        )
        this.extractionCoordinator = new LivingMemoryExtractionCoordinator(
            ctx,
            config,
            this.repository,
            formatter,
            extractor,
            jobTracker,
            this.serviceLogger,
            debug
        )
        this.dreamCoordinator = new LivingMemoryDreamCoordinator(
            dream,
            this.repository,
            this.snapshotCache,
            jobTracker,
            this.serviceLogger,
            debug
        )
        this.presetCatalog = new LivingMemoryPresetCatalog(
            ctx,
            this.repository,
            debug
        )

        this.repository.defineTables()
        ctx.setInterval(() => {
            this.cleanupStaleJobs().catch((error) => {
                this.serviceLogger.warn(error)
            })
        }, Time.day)
    }

    protected async start() {
        try {
            const recovered =
                await this.repository.markStaleRunningJobsAsFailed(
                    {},
                    'recovered: service restarted while job was running'
                )
            if (recovered.length > 0) {
                this.serviceLogger.info(
                    `memory startup recovery: marked ${recovered.length} stale running job(s) as failed`
                )
            }
        } catch (error) {
            this.serviceLogger.warn(error)
        }

        for (const warning of this.validateConfig()) {
            this.serviceLogger.warn(
                `memory config warning [${warning.code}] ${warning.message}`
            )
        }
    }

    validateConfig(): MemoryConfigWarning[] {
        const warnings: MemoryConfigWarning[] = []

        if (
            this.config.recallStrategy === 'embedding-rerank' &&
            !isModelConfigured(this.config.embeddingModel)
        ) {
            warnings.push({
                code: 'embedding-model-missing',
                field: 'embeddingModel',
                message: '未配置 embeddingModel；记忆召回将失败。'
            })
        }
        if (
            this.config.recallStrategy === 'embedding-rerank' &&
            !isModelConfigured(this.config.rerankModel)
        ) {
            warnings.push({
                code: 'rerank-model-missing',
                field: 'rerankModel',
                message: '未配置 rerankModel；记忆召回将失败。'
            })
        }

        if (
            this.config.extractionInterval > 0 &&
            !isModelConfigured(this.config.extractModel)
        ) {
            warnings.push({
                code: 'extract-model-missing',
                field: 'extractModel',
                message:
                    '自动记忆提取已启用（extractionInterval > 0），但未配置 extractModel；提取流程将被跳过。'
            })
        }

        if (
            this.config.recallStrategy === 'embedding-rerank' &&
            this.config.enableRecallQueryRewrite &&
            !isModelConfigured(this.config.recallRewriteModel)
        ) {
            warnings.push({
                code: 'recall-rewrite-model-missing',
                field: 'recallRewriteModel',
                message:
                    '召回查询改写已启用，但未配置 recallRewriteModel；将回退到原始查询。'
            })
        }

        if (
            this.config.recallStrategy === 'agentic-recall' &&
            !isModelConfigured(this.config.agenticRecallModel)
        ) {
            warnings.push({
                code: 'agentic-recall-model-missing',
                field: 'agenticRecallModel',
                message:
                    'agentic-recall 已启用，但未配置 agenticRecallModel；记忆召回将失败。'
            })
        }

        return warnings
    }

    getStatus(): MemoryServiceStatus {
        return {
            warnings: this.validateConfig()
        }
    }

    private debug(message: string) {
        if (this.config.debug) {
            this.serviceLogger.info(message)
        }
    }

    shouldHandleSession(isDirect: boolean) {
        return typeof isDirect === 'boolean'
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
        options: Partial<
            Pick<
                MemoryScope,
                | 'guildId'
                | 'isDirect'
                | 'speakerId'
                | 'speakerName'
                | 'presetLabel'
            >
        > = {}
    ): MemoryScope {
        return {
            conversationId,
            presetId,
            userId,
            channelId,
            ...options
        }
    }

    async recordPresetSpeaker(
        scope: Pick<MemoryScope, 'presetId' | 'speakerId' | 'userId'>,
        speakerLabel: string
    ) {
        const label = normalizeUserProfileSpeakerLabel(speakerLabel)
        const speakerKey = normalizeUserProfileSpeakerKey(label)
        if (label.length === 0 || speakerKey.length === 0) {
            return
        }

        await this.repository.upsertPresetSpeaker({
            presetId: scope.presetId,
            speakerKey,
            speakerLabel: label,
            speakerId: scope.speakerId ?? scope.userId ?? null
        })
    }

    async hydratePromptVariable(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        return await this.snapshotCache.hydrate(scope)
    }

    async hydratePromptSections(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>,
        options: {
            includeSnapshot?: boolean
            speakerLabels?: string[]
        } = {}
    ) {
        const [snapshot, userProfiles] = await Promise.all([
            options.includeSnapshot === false
                ? Promise.resolve('')
                : this.snapshotCache.hydrate(scope),
            this.userProfiles.renderForSpeakers(
                scope.presetId,
                options.speakerLabels ?? []
            )
        ])

        return {
            snapshot,
            userProfiles
        }
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
        chatCount: number,
        messages: LivingMemoryTranscriptMessage[],
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {},
        options: QueueExtractionOptions = {}
    ) {
        await this.extractionCoordinator.queue(
            scope,
            chatCount,
            messages,
            presetTemplate,
            promptVariables,
            options
        )
    }

    async cleanupConversation(conversationId: string) {
        await this.repository.deleteSnapshotsByConversation(conversationId)
        this.snapshotCache.clearByConversation(conversationId)
        this.extractionCoordinator.clearByConversation(conversationId)
    }

    async listPresetIds(): Promise<string[]> {
        return await this.presetCatalog.list()
    }

    async listMemories(query: MemoryListQuery) {
        const items = await this.repository.listEntriesByPreset(query.presetId)
        return filterMemoryList(items, query)
    }

    async searchMemories(
        presetId: string,
        options: LivingMemorySearchOptions
    ): Promise<LivingMemorySearchResult[]> {
        const items = await this.repository.listEntriesByPreset(presetId)
        return searchLivingMemoryEntries(items, {
            maxCandidates: options.maxCandidates,
            broadSearchTexts: options.broadSearchTexts,
            specificSearchTexts: options.specificSearchTexts,
            memoryTypes: options.memoryTypes
        })
    }

    async getMemory(memoryId: string) {
        return await this.repository.getEntryById(memoryId)
    }

    async createMemory(scope: MemoryScope, input: MemoryMutationInput) {
        return await this.repository.createMemory(scope, input)
    }

    async updateMemory(memoryId: string, patch: Partial<MemoryMutationInput>) {
        await this.repository.updateMemory(memoryId, patch)
    }

    async deleteMemory(memoryId: string) {
        await this.repository.deleteMemory(memoryId)
    }

    async deleteSnapshot(snapshotId: string) {
        const deleted = await this.repository.deleteSnapshot(snapshotId)
        if (deleted != null) {
            this.snapshotCache.clearByScope(deleted)
        }
    }

    async listSnapshots(
        query: SnapshotListQuery
    ): Promise<PageResult<MemorySnapshotWithResolvedItems>> {
        const items = await this.repository.listSnapshotsByPreset(
            query.presetId
        )
        const page = filterSnapshotList(items, query)
        const memoryIds = [
            ...new Set(
                page.items.flatMap((snapshot) =>
                    snapshot.items.flatMap((item) =>
                        isMemoryReferenceItem(item) ? [item.memoryId] : []
                    )
                )
            )
        ]
        const records = await this.repository.getEntriesByIds(memoryIds)
        const recordById = new Map(records.map((record) => [record.id, record]))

        return {
            ...page,
            items: page.items.map((snapshot) => ({
                ...snapshot,
                resolvedItems: snapshot.items
                    .filter(isMemoryReferenceItem)
                    .map((item) => {
                        const memory = recordById.get(item.memoryId) ?? null
                        return {
                            ...item,
                            memory,
                            missing: memory == null
                        }
                    })
            }))
        }
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

    async deleteUserProfile(profileId: string) {
        await this.repository.deleteUserProfile(profileId)
    }

    async runDream(presetId: string): Promise<DreamTriggerResult> {
        return await this.dreamCoordinator.run(presetId)
    }

    async clearPresetData(presetId: string) {
        await this.repository.clearAllByPreset(presetId)
        this.snapshotCache.clearByPreset(presetId)
    }

    async cleanupStaleJobs(maxAge: number = Time.week) {
        await this.repository.removeExpiredJobs(new Date(Date.now() - maxAge))
    }
}
