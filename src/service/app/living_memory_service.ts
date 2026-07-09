import type { HumanMessage } from '@langchain/core/messages'
import { Context, Logger, Service, Time } from 'koishi'
import type { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { LivingMemoryDreamService } from '../workflows/dream'
import { LivingMemoryExtractor } from '../workflows/extraction/extractor'
import { LivingMemoryMessageFormatter } from '../transcript/message_formatter'
import { LivingMemoryRecallQueryBuilder } from '../workflows/recall/query_builder'
import {
    type LivingMemorySearchOptions,
    searchLivingMemoryEntries
} from '../memory/tools/search'
import { LivingMemoryRepository } from '../persistence/repository'
import { LivingMemoryRetriever } from '../workflows/recall/retriever'
import {
    LivingMemoryUserProfileService,
    normalizeUserProfileSpeakerKey,
    normalizeUserProfileSpeakerLabel
} from '../user_profile'
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
    LivingMemoryGetMessagesOutput,
    LivingMemorySearchResult,
    LivingMemoryTranscriptMessage,
    MemoryConfigWarning,
    MemoryMutationInput,
    MemoryScope,
    MemoryServiceStatus,
    MemorySnapshotWithResolvedItems
} from '../../types'
import { LivingMemoryDreamCoordinator } from '../workflows/dream/coordinator'
import { LivingMemoryExtractionCoordinator } from '../workflows/extraction/coordinator'
import { LivingMemoryJobTracker } from '../workflows/job_tracker'
import { LivingMemoryPresetCatalog } from '../memory/preset_catalog'
import { LivingMemoryRecallCoordinator } from '../workflows/recall/coordinator'
import { LivingMemorySnapshotCache } from '../memory/snapshot/snapshot_cache'
import { LivingMemoryAgenticRecallExecutor } from '../workflows/recall/agentic_recall'
import { isMemoryReferenceItem } from '../memory/snapshot/snapshot_items'
import type { QueueExtractionOptions } from '../memory/helpers'
import { cloneSourceMessage } from '../memory/origins/source_origins'
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

export type { QueueExtractionOptions } from '../memory/helpers'

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
        this.dreamCoordinator = new LivingMemoryDreamCoordinator(
            config,
            dream,
            this.repository,
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
            (presetId) => this.queueAutoDreamIfThresholdReached(presetId),
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
        const repaired = await this.repository.migrateMemorySourceOriginsArray()
        if (repaired > 0) {
            this.serviceLogger.info(
                `memory startup migration: repaired ${repaired} invalid sourceOrigins record(s)`
            )
        }

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
        return validateLivingMemoryConfig(this.config)
    }

    getStatus(): MemoryServiceStatus {
        return createLivingMemoryServiceStatus(this.config)
    }

    private debug(message: string) {
        if (this.config.debug) {
            this.serviceLogger.info(message)
        }
    }

    private queueAutoDreamIfThresholdReached(presetId: string) {
        this.dreamCoordinator
            .queueAutoIfThresholdReached(presetId)
            .catch((error) => {
                this.serviceLogger.warn(error)
            })
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

    async getMemorySourceMessages(
        presetId: string,
        memoryIds: string[]
    ): Promise<LivingMemoryGetMessagesOutput> {
        const orderedIds = [...new Set(memoryIds)]
        const entries = await this.repository.getEntriesByPresetAndIds(
            presetId,
            orderedIds
        )
        const entryById = new Map(entries.map((entry) => [entry.id, entry]))

        return {
            memories: orderedIds.flatMap((id) => {
                const entry = entryById.get(id)
                if (entry == null) {
                    return []
                }

                return [
                    {
                        id: entry.id,
                        type: entry.type,
                        content: entry.content,
                        keywords: [...entry.keywords],
                        summary: entry.summary,
                        importance: entry.importance,
                        createdAt: entry.createdAt.toISOString(),
                        updatedAt: entry.updatedAt.toISOString(),
                        sourceOrigins: entry.sourceOrigins.map(
                            (origin, originIndex) => ({
                                originIndex,
                                messages:
                                    origin.messages.map(cloneSourceMessage)
                            })
                        )
                    }
                ]
            }),
            notFoundMemoryIds: orderedIds.filter((id) => !entryById.has(id))
        }
    }

    async createMemory(scope: MemoryScope, input: MemoryMutationInput) {
        const memory = await this.repository.createMemory(scope, input)
        this.queueAutoDreamIfThresholdReached(scope.presetId)
        return memory
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
