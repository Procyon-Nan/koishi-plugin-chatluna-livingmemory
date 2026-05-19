import { BaseMessage, HumanMessage } from '@langchain/core/messages'
import { Context, Logger, Service, Time } from 'koishi'
import type { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { LivingMemoryDreamService } from './dream'
import { LivingMemoryExtractor } from './extractor'
import { LivingMemoryMessageFormatter } from './message_formatter'
import { LivingMemoryRecallQueryBuilder } from './recall_query'
import { LivingMemoryRepository } from './repository'
import { LivingMemoryRetriever } from './retriever'
import {
    formatDateOnly,
    isModelConfigured,
    summarizeError
} from './shared/utils'
import {
    filterJobList,
    filterMemoryList,
    filterSnapshotList,
    type JobListQuery,
    type MemoryListQuery,
    type PageResult,
    type SnapshotListQuery
} from '../query'
import type {
    DreamTriggerResult,
    LivingMemoryConfig,
    MemoryConfigWarning,
    MemoryMutationInput,
    MemoryScope,
    MemoryServiceStatus,
    MemorySnapshotRecord,
    MemorySnapshotWithResolvedItems
} from '../types'

const normalizeText = (value: string) => value.trim()

const formatMemoryItemsForLog = (
    items: { content: string; score?: number }[]
) => {
    if (items.length === 0) {
        return '[]'
    }

    return items
        .map((item, index) => {
            const score = item.score == null ? '' : ` score=${item.score}`
            return `${index + 1}.${score} ${item.content}`
        })
        .join('\n')
}

const stringifyMessageContent = (content: unknown) => {
    if (typeof content === 'string') {
        return content.trim()
    }

    if (!Array.isArray(content)) {
        return ''
    }

    return content
        .map((part) => {
            if (
                part != null &&
                typeof part === 'object' &&
                typeof (part as Record<string, unknown>).text === 'string'
            ) {
                return (part as { text: string }).text.trim()
            }

            return ''
        })
        .filter((part) => part.length > 0)
        .join('\n')
}

const formatRenderedPresetPrompt = (messages: BaseMessage[]) => {
    const formattedMessages = messages
        .filter((message) => message.getType() === 'system')
        .map((message) => {
            const content = stringifyMessageContent(message.content)
            if (content.length === 0) {
                return null
            }

            return content
        })
        .filter((message): message is string => message != null)

    if (formattedMessages.length === 0) {
        return null
    }

    return [
        '# 当前 preset prompt（仅用于理解“我”的人设，不要从此处抽取记忆）',
        ...formattedMessages
    ].join('\n\n')
}

export interface QueueExtractionOptions {
    presetPromptOverride?: string | null
    preselectedMessages?: BaseMessage[]
}

export class ChatLunaLivingMemoryService extends Service<LivingMemoryConfig> {
    private readonly serviceLogger: Logger
    private readonly snapshotVariableByScope = new Map<string, string>()
    private readonly extractionLockByConversation = new Set<string>()
    private readonly recallLockByConversation = new Set<string>()
    private readonly dreamLockByPreset = new Map<string, string>()
    private readonly repository: LivingMemoryRepository
    private readonly retriever: LivingMemoryRetriever
    private readonly extractor: LivingMemoryExtractor
    private readonly formatter: LivingMemoryMessageFormatter
    private readonly recallQuery: LivingMemoryRecallQueryBuilder
    private readonly dream: LivingMemoryDreamService

    constructor(
        public readonly ctx: Context,
        public config: LivingMemoryConfig
    ) {
        super(ctx, 'chatluna_living_memory', true)
        this.serviceLogger = ctx.logger('chatluna-livingmemory')
        this.repository = new LivingMemoryRepository(ctx)
        this.retriever = new LivingMemoryRetriever(ctx, config, this.repository)
        this.extractor = new LivingMemoryExtractor(ctx, config.extractModel)
        this.formatter = new LivingMemoryMessageFormatter()
        this.recallQuery = new LivingMemoryRecallQueryBuilder(ctx, config)
        this.dream = new LivingMemoryDreamService(
            ctx,
            config,
            this.repository,
            this.debug.bind(this)
        )
        this.repository.defineTables()
        this.registerPromptFunction()
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

        if (this.config.recallStrategy === 'embedding-rerank') {
            if (!isModelConfigured(this.config.embeddingModel)) {
                warnings.push({
                    code: 'embedding-model-missing',
                    field: 'embeddingModel',
                    message:
                        '召回策略已选择 embedding-rerank，但未配置 embeddingModel；将无法进行向量召回。'
                })
            }
            if (!isModelConfigured(this.config.rerankModel)) {
                warnings.push({
                    code: 'rerank-model-missing',
                    field: 'rerankModel',
                    message:
                        '召回策略已选择 embedding-rerank，但未配置 rerankModel；将无法对召回结果重排序。'
                })
            }
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

        return warnings
    }

    getStatus(): MemoryServiceStatus {
        return {
            warnings: this.validateConfig()
        }
    }

    private registerPromptFunction() {
        this.ctx.effect(() =>
            this.ctx.chatluna.promptRenderer.registerFunctionProvider(
                'living_memory',
                async (_args, variables) => {
                    const built =
                        variables != null && typeof variables === 'object'
                            ? (
                                  variables as {
                                      built?: {
                                          conversationId?: string
                                          preset?: string
                                      }
                                  }
                              ).built
                            : undefined
                    const presetId = built?.preset
                    if (typeof presetId !== 'string' || presetId.length === 0) {
                        return ''
                    }

                    const conversationId = built?.conversationId
                    if (
                        typeof conversationId !== 'string' ||
                        conversationId.length === 0
                    ) {
                        return ''
                    }

                    return await this.renderSnapshot(presetId, conversationId)
                }
            )
        )
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

    private toSnapshotCacheKey(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        return `${scope.presetId}\n${scope.conversationId}`
    }

    private clearSnapshotCacheByScope(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        this.snapshotVariableByScope.delete(this.toSnapshotCacheKey(scope))
    }

    private clearSnapshotCacheByPreset(presetId: string) {
        for (const key of this.snapshotVariableByScope.keys()) {
            if (key.startsWith(`${presetId}\n`)) {
                this.snapshotVariableByScope.delete(key)
            }
        }
    }

    private clearSnapshotCacheByConversation(conversationId: string) {
        for (const key of this.snapshotVariableByScope.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.snapshotVariableByScope.delete(key)
            }
        }
    }

    async hydratePromptVariable(
        scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
    ) {
        const snapshot = await this.repository.getLatestSnapshotByScope(scope)
        const rendered = await this.renderSnapshotItems(snapshot?.items ?? [])
        this.snapshotVariableByScope.set(
            this.toSnapshotCacheKey(scope),
            rendered
        )
        return rendered
    }

    async renderSnapshot(presetId: string, conversationId: string) {
        const scope = { presetId, conversationId }
        const cached = this.snapshotVariableByScope.get(
            this.toSnapshotCacheKey(scope)
        )
        if (cached != null) {
            return cached
        }

        return await this.hydratePromptVariable(scope)
    }

    async queueRecall(
        scope: MemoryScope,
        currentMessage: HumanMessage,
        loadHistoryMessages: () => Promise<BaseMessage[]>
    ) {
        const lockKey = this.toSnapshotCacheKey(scope)
        if (this.recallLockByConversation.has(lockKey)) {
            return
        }

        this.recallLockByConversation.add(lockKey)

        this.runRecall(scope, currentMessage, loadHistoryMessages)
            .catch((error) => {
                this.serviceLogger.warn(error)
            })
            .finally(() => {
                this.recallLockByConversation.delete(lockKey)
            })
    }

    async queueExtraction(
        scope: MemoryScope,
        chatCount: number,
        messages: BaseMessage[],
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {},
        options: QueueExtractionOptions = {}
    ) {
        this.debug(
            [
                'queueExtraction:',
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `chatCount=${chatCount}`,
                `interval=${this.config.extractionInterval}`,
                `messagesLength=${messages.length}`
            ].join(' ')
        )

        if (this.config.extractionInterval <= 0) {
            this.debug(
                [
                    'queueExtraction skipped: auto extraction disabled,',
                    `conversationId=${scope.conversationId}`,
                    `interval=${this.config.extractionInterval}`
                ].join(' ')
            )
            return
        }

        if (chatCount < this.config.extractionRounds) {
            this.debug(
                [
                    'queueExtraction skipped: insufficient rounds,',
                    `conversationId=${scope.conversationId}`,
                    `chatCount=${chatCount}`,
                    `extractionRounds=${this.config.extractionRounds}`
                ].join(' ')
            )
            return
        }

        if (chatCount % this.config.extractionInterval !== 0) {
            this.debug(
                [
                    'queueExtraction skipped: interval not matched,',
                    `conversationId=${scope.conversationId}`,
                    `chatCount=${chatCount}`,
                    `interval=${this.config.extractionInterval}`
                ].join(' ')
            )
            return
        }

        const lockKey = this.toSnapshotCacheKey(scope)
        if (this.extractionLockByConversation.has(lockKey)) {
            this.debug(
                `queueExtraction skipped: locked, conversationId=${scope.conversationId}`
            )
            return
        }

        const rounds =
            options.preselectedMessages ??
            this.formatter.takeRecentRounds(
                messages,
                this.config.extractionRounds
            )
        if (rounds.length === 0) {
            this.debug(
                [
                    'queueExtraction skipped: no complete rounds,',
                    `conversationId=${scope.conversationId}`,
                    `messagesLength=${messages.length}`,
                    `extractionRounds=${this.config.extractionRounds}`
                ].join(' ')
            )
            return
        }

        this.debug(
            [
                'queueExtraction accepted:',
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `roundsLength=${rounds.length}`
            ].join(' ')
        )

        this.extractionLockByConversation.add(lockKey)

        this.runExtraction(
            scope,
            rounds,
            presetTemplate,
            promptVariables,
            options.presetPromptOverride
        )
            .catch((error) => {
                this.serviceLogger.warn(error)
            })
            .finally(() => {
                this.extractionLockByConversation.delete(lockKey)
            })
    }

    private async runRecall(
        scope: MemoryScope,
        currentMessage: HumanMessage,
        loadHistoryMessages: () => Promise<BaseMessage[]>
    ) {
        let historyMessages: BaseMessage[] = []
        try {
            historyMessages = await loadHistoryMessages()
        } catch (error) {
            this.debug(
                [
                    `memory recall history unavailable: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
        }

        const query = await this.recallQuery.resolve(
            scope,
            currentMessage,
            historyMessages
        )

        this.debug(
            [
                `memory recall query prepared: conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `rawInputLength=${query.rawInputLength}`,
                'cleanedQuery:',
                query.cleanedQuery,
                'finalQuery:',
                query.finalQuery
            ].join('\n')
        )

        if (query.skippedReason != null) {
            this.debug(
                [
                    `memory recall skipped: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `reason=${query.skippedReason}`
                ].join(' ')
            )
            return
        }

        if (query.rewritePrompt != null) {
            this.debug(
                [
                    `memory recall rewrite input: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    query.rewritePrompt
                ].join('\n')
            )
        }

        if (query.rewriteOutput != null) {
            this.debug(
                [
                    `memory recall rewrite output: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    query.rewriteOutput
                ].join('\n')
            )
        }

        if (query.fallbackReason != null) {
            this.debug(
                [
                    `memory recall rewrite fallback: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `reason=${query.fallbackReason}`,
                    query.error == null ? '' : `error=${query.error}`,
                    `finalQuery=${query.finalQuery}`
                ]
                    .filter((part) => part.length > 0)
                    .join(' ')
            )
        }

        const input = normalizeText(query.finalQuery)
        if (input.length === 0) {
            return
        }

        const job = await this.repository.createJob(scope, 'recall', input)

        try {
            await this.markJobRunning(job.id)

            const items = await this.retriever.retrieve(
                scope.presetId,
                input,
                this.config.recallTopK
            )
            this.debug(
                [
                    `memory recall: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `query=${input}\n${formatMemoryItemsForLog(items)}`
                ].join(' ')
            )

            await this.repository.upsertSnapshot(
                scope,
                this.config.recallStrategy,
                input,
                items.map((item) => ({
                    memoryId: item.id,
                    score: item.score
                }))
            )
            await this.hydratePromptVariable(scope)

            await this.markJobCompleted(
                job.id,
                `matched ${items.length} memories`
            )
        } catch (error) {
            await this.markJobFailed(job.id, error)
            throw error
        }
    }

    private async runExtraction(
        scope: MemoryScope,
        messages: BaseMessage[],
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {},
        presetPromptOverride?: string | null
    ) {
        const payload = this.formatter.toExtractionPayload(scope, messages)
        const job = await this.repository.createJob(
            scope,
            'extract',
            payload.input
        )

        this.debug(
            [
                `runExtraction started: jobId=${job.id}`,
                `conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                `sourceMessages=${payload.sourceMessages.length}`,
                `inputLength=${payload.input.length}`
            ].join(' ')
        )

        try {
            await this.markJobRunning(job.id)

            const presetPrompt =
                presetPromptOverride ??
                (await this.renderExtractionPresetPrompt(
                    scope,
                    presetTemplate,
                    promptVariables
                ))
            const trace = await this.extractor.extractWithTrace(payload.input, {
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                presetLabel: scope.presetLabel,
                currentDate: formatDateOnly(new Date()),
                presetPrompt
            })
            if (trace.skippedReason != null) {
                this.debug(
                    [
                        `memory extraction skipped: jobId=${job.id}`,
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `reason=${trace.skippedReason}`
                    ].join(' ')
                )
            }

            if (trace.prompt != null && trace.output != null) {
                this.debug(
                    [
                        `memory extraction llm input: jobId=${job.id}`,
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        trace.prompt
                    ].join('\n')
                )
                this.debug(
                    [
                        `memory extraction llm output: jobId=${job.id}`,
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        trace.output
                    ].join('\n')
                )
            }

            const extracted = trace.extracted
            this.debug(
                [
                    `memory extraction: jobId=${job.id}`,
                    `conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `count=${extracted.length}\n${formatMemoryItemsForLog(extracted)}`
                ].join(' ')
            )

            if (extracted.length > 0) {
                await this.repository.appendMemories(
                    scope,
                    payload.sourceMessages,
                    extracted
                )
            }

            await this.markJobCompleted(
                job.id,
                `extracted ${extracted.length} memories`
            )
            this.debug(
                `runExtraction completed: jobId=${job.id}, extracted=${extracted.length}`
            )
        } catch (error) {
            await this.markJobFailed(job.id, error)
            throw error
        }
    }

    private async renderExtractionPresetPrompt(
        scope: MemoryScope,
        presetTemplate?: PresetTemplate,
        promptVariables: Record<string, unknown> = {}
    ) {
        if (presetTemplate == null) {
            this.debug(
                [
                    `memory extraction preset prompt skipped: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    'reason=preset-unavailable'
                ].join(' ')
            )
            return null
        }

        try {
            const rendered =
                await this.ctx.chatluna.promptRenderer.renderPresetTemplate(
                    presetTemplate,
                    promptVariables
                )
            const presetPrompt = formatRenderedPresetPrompt(rendered.messages)
            if (presetPrompt == null) {
                this.debug(
                    [
                        `memory extraction preset prompt skipped: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        'reason=empty-rendered-prompt'
                    ].join(' ')
                )
            }

            return presetPrompt
        } catch (error) {
            this.debug(
                [
                    `memory extraction preset prompt skipped: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    'reason=render-failed',
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
            return null
        }
    }

    private async markJobRunning(id: string) {
        await this.repository.updateJob(id, {
            status: 'running',
            startedAt: new Date(),
            updatedAt: new Date()
        })
    }

    private async markJobCompleted(id: string, detail: string) {
        await this.repository.updateJob(id, {
            status: 'completed',
            finishedAt: new Date(),
            updatedAt: new Date(),
            detail
        })
    }

    private async markJobFailed(id: string, error: unknown) {
        await this.repository.updateJob(id, {
            status: 'failed',
            finishedAt: new Date(),
            updatedAt: new Date(),
            error: summarizeError(error)
        })
    }

    private async renderSnapshotItems(items: MemorySnapshotRecord['items']) {
        if (items.length === 0) {
            return ''
        }

        const records = await this.repository.getEntriesByIds(
            items.map((item) => item.memoryId)
        )
        if (records.length === 0) {
            return ''
        }

        const ordered = items
            .map((item) =>
                records.find((record) => record.id === item.memoryId)
            )
            .filter(
                (record): record is NonNullable<typeof record> =>
                    record != null && record.status === 'active'
            )

        return ordered
            .map(
                (record) =>
                    `记录于 ${formatDateOnly(record.createdAt)}：${record.content}`
            )
            .join('\n')
    }

    async cleanupConversation(conversationId: string) {
        await this.repository.deleteSnapshotsByConversation(conversationId)
        this.clearSnapshotCacheByConversation(conversationId)
    }

    async listPresetIds(): Promise<string[]> {
        return await this.repository.listDistinctPresetIds()
    }

    async listMemories(query: MemoryListQuery) {
        const items = await this.repository.listEntriesByPreset(query.presetId)
        return filterMemoryList(items, query)
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
            this.clearSnapshotCacheByScope(deleted)
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
                    snapshot.items.map((item) => item.memoryId)
                )
            )
        ]
        const records = await this.repository.getEntriesByIds(memoryIds)
        const recordById = new Map(records.map((record) => [record.id, record]))

        return {
            ...page,
            items: page.items.map((snapshot) => ({
                ...snapshot,
                resolvedItems: snapshot.items.map((item) => {
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

    async runDream(presetId: string): Promise<DreamTriggerResult> {
        if (this.dreamLockByPreset.has(presetId)) {
            const runningJobId = this.dreamLockByPreset.get(presetId)
            return {
                success: true,
                started: false,
                reason: 'preset-locked',
                runningJobId: runningJobId?.length ? runningJobId : undefined
            }
        }

        this.dreamLockByPreset.set(presetId, '')

        try {
            await this.recoverStaleDreamJobs(presetId)

            const scope = this.createScope(`dream:${presetId}`, presetId)
            const job = await this.repository.createJob(
                scope,
                'dream',
                presetId
            )

            this.dreamLockByPreset.set(presetId, job.id)
            this.runDreamJob(scope, job.id)
                .catch((error) => {
                    this.serviceLogger.warn(error)
                })
                .finally(() => {
                    if (this.dreamLockByPreset.get(presetId) === job.id) {
                        this.dreamLockByPreset.delete(presetId)
                    }
                })

            return {
                success: true,
                started: true
            }
        } catch (error) {
            if (this.dreamLockByPreset.get(presetId) === '') {
                this.dreamLockByPreset.delete(presetId)
            }
            throw error
        }
    }

    private async runDreamJob(scope: MemoryScope, jobId: string) {
        try {
            await this.markJobRunning(jobId)
            const result = await this.dream.run(scope.presetId)
            this.debug(
                [
                    `memory dream completed: jobId=${jobId}`,
                    `presetId=${scope.presetId}`,
                    result.detail
                ].join(' ')
            )
            await this.markJobCompleted(jobId, result.detail)
            if (result.merged + result.updated + result.archived > 0) {
                this.refreshDreamSnapshotCache(scope.presetId, jobId)
            }
        } catch (error) {
            await this.markJobFailed(jobId, error)
            throw error
        }
    }

    private async recoverStaleDreamJobs(presetId: string) {
        const recovered = await this.repository.markStaleRunningJobsAsFailed(
            { presetId, kind: 'dream' },
            'dream recovered: stale running job'
        )
        if (recovered.length > 0) {
            this.debug(
                `memory dream stale jobs recovered: presetId=${presetId}, count=${recovered.length}`
            )
        }
    }

    private refreshDreamSnapshotCache(presetId: string, jobId: string) {
        this.clearSnapshotCacheByPreset(presetId)
        this.debug(
            [
                `memory dream cache cleared: jobId=${jobId}`,
                `presetId=${presetId}`
            ].join(' ')
        )
    }

    async clearPresetData(presetId: string) {
        await this.repository.clearAllByPreset(presetId)
        this.clearSnapshotCacheByPreset(presetId)
    }

    async cleanupStaleJobs(maxAge: number = Time.week) {
        await this.repository.removeExpiredJobs(new Date(Date.now() - maxAge))
    }
}
