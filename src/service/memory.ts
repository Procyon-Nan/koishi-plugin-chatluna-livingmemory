import { BaseMessage, HumanMessage } from '@langchain/core/messages'
import { Context, Logger, Service, Time } from 'koishi'
import { LivingMemoryExtractor } from './extractor'
import { LivingMemoryMessageFormatter } from './message_formatter'
import { LivingMemoryRepository } from './repository'
import { LivingMemoryRetriever } from './retriever'
import {
    filterJobList,
    filterMemoryList,
    filterSnapshotList,
    type JobListQuery,
    type MemoryListQuery,
    type SnapshotListQuery
} from '../query'
import type {
    LivingMemoryConfig,
    MemoryMutationInput,
    MemoryScope,
    MemorySnapshotRecord
} from '../types'

const normalizeText = (value: string) => value.trim()

const summarizeError = (error: unknown) => {
    if (error instanceof Error) {
        return error.stack ?? error.message
    }

    if (typeof error === 'string') {
        return error
    }

    return JSON.stringify(error)
}

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

export class ChatLunaLivingMemoryService extends Service<LivingMemoryConfig> {
    private readonly serviceLogger: Logger
    private readonly snapshotVariableByPreset = new Map<string, string>()
    private readonly extractionLockByConversation = new Set<string>()
    private readonly recallLockByConversation = new Set<string>()
    private readonly repository: LivingMemoryRepository
    private readonly retriever: LivingMemoryRetriever
    private readonly extractor: LivingMemoryExtractor
    private readonly formatter: LivingMemoryMessageFormatter

    constructor(
        public readonly ctx: Context,
        public config: LivingMemoryConfig
    ) {
        super(ctx, 'chatluna_living_memory', true)
        this.serviceLogger = ctx.logger('chatluna-livingmemory')
        this.repository = new LivingMemoryRepository(ctx)
        this.retriever = new LivingMemoryRetriever(ctx, config, this.repository)
        this.extractor = new LivingMemoryExtractor(
            ctx,
            config.extractModel,
            config.extractionPrompt
        )
        this.formatter = new LivingMemoryMessageFormatter()
        this.repository.defineTables()
        this.registerPromptFunction()
        ctx.setInterval(() => {
            this.cleanupStaleJobs().catch((error) => {
                this.serviceLogger.warn(error)
            })
        }, Time.day)
    }

    protected async start() {
        await this.repository
            .trimAllSnapshots(this.config.maxSnapshotsPerPreset)
            .catch((error) => {
                this.serviceLogger.warn(error)
            })
    }

    private registerPromptFunction() {
        this.ctx.effect(() =>
            this.ctx.chatluna.promptRenderer.registerFunctionProvider(
                'living_memory',
                async (_args, variables) => {
                    const built =
                        variables != null && typeof variables === 'object'
                            ? (variables as { built?: { preset?: string } })
                                  .built
                            : undefined
                    const presetId = built?.preset
                    if (typeof presetId !== 'string' || presetId.length === 0) {
                        return ''
                    }

                    return await this.renderSnapshot(presetId)
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
        return isDirect
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
        channelId?: string
    ): MemoryScope {
        return {
            conversationId,
            presetId,
            userId,
            channelId
        }
    }

    async hydratePromptVariable(presetId: string) {
        const snapshot =
            await this.repository.getLatestSnapshotByPreset(presetId)
        const rendered = await this.renderSnapshotItems(snapshot?.items ?? [])
        this.snapshotVariableByPreset.set(presetId, rendered)
        return rendered
    }

    async renderSnapshot(presetId: string) {
        const cached = this.snapshotVariableByPreset.get(presetId)
        if (cached != null) {
            return cached
        }

        return await this.hydratePromptVariable(presetId)
    }

    async queueRecall(scope: MemoryScope, input: string) {
        const normalizedInput = normalizeText(input)
        if (normalizedInput.length === 0) {
            return
        }

        if (this.recallLockByConversation.has(scope.conversationId)) {
            return
        }

        this.recallLockByConversation.add(scope.conversationId)

        this.runRecall(scope, normalizedInput)
            .catch((error) => {
                this.serviceLogger.warn(error)
            })
            .finally(() => {
                this.recallLockByConversation.delete(scope.conversationId)
            })
    }

    async queueExtraction(
        scope: MemoryScope,
        chatCount: number,
        messages: BaseMessage[]
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

        if (this.extractionLockByConversation.has(scope.conversationId)) {
            this.debug(
                `queueExtraction skipped: locked, conversationId=${scope.conversationId}`
            )
            return
        }

        const rounds = this.formatter.takeRecentRounds(
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

        this.extractionLockByConversation.add(scope.conversationId)

        this.runExtraction(scope, rounds)
            .catch((error) => {
                this.serviceLogger.warn(error)
            })
            .finally(() => {
                this.extractionLockByConversation.delete(scope.conversationId)
            })
    }

    private async runRecall(scope: MemoryScope, input: string) {
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

            await this.repository.createSnapshot(
                scope,
                this.config.recallStrategy,
                input,
                items.map((item) => ({
                    memoryId: item.id,
                    score: item.score
                }))
            )
            await this.repository.trimSnapshots(
                scope.presetId,
                this.config.maxSnapshotsPerPreset
            )
            await this.hydratePromptVariable(scope.presetId)

            await this.markJobCompleted(
                job.id,
                `matched ${items.length} memories`
            )
        } catch (error) {
            await this.markJobFailed(job.id, error)
            throw error
        }
    }

    private async runExtraction(scope: MemoryScope, messages: BaseMessage[]) {
        const payload = this.formatter.toExtractionPayload(messages)
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

            const extracted = await this.extractor.extract(payload.input)
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
                (record): record is NonNullable<typeof record> => record != null
            )

        return ordered
            .map((record, index) => `记忆${index + 1}：${record.content}`)
            .join('\n')
    }

    async cleanupConversation(_conversationId: string) {}

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

    async listSnapshots(query: SnapshotListQuery) {
        const items = await this.repository.listSnapshotsByPreset(
            query.presetId
        )
        return filterSnapshotList(items, query)
    }

    async listJobs(query: JobListQuery) {
        const items = await this.repository.listJobsByPreset(query.presetId)
        return filterJobList(items, query)
    }

    async runDream(presetId: string) {
        const scope = this.createScope(`dream:${presetId}`, presetId)
        const job = await this.repository.createJob(scope, 'dream', presetId)

        try {
            await this.markJobRunning(job.id)
            await this.markJobCompleted(job.id, 'dream placeholder completed')
        } catch (error) {
            await this.markJobFailed(job.id, error)
            throw error
        }
    }

    async clearPresetData(presetId: string) {
        await this.repository.clearAllByPreset(presetId)
        this.snapshotVariableByPreset.delete(presetId)
    }

    async cleanupStaleJobs(maxAge: number = Time.week) {
        await this.repository.removeExpiredJobs(new Date(Date.now() - maxAge))
    }
}
