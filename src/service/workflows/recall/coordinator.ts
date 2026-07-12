import type { Logger } from 'koishi'
import type { LivingMemoryRetriever } from './retriever'
import type { LivingMemoryRecallQueryBuilder } from './query_builder'
import { summarizeError } from '../../shared/utils'
import {
    type DebugLogger,
    formatMemoryItemsForLog,
    normalizeText,
    scopeKey
} from '../../memory/helpers'
import type { LivingMemoryJobTracker } from '../job_tracker'
import type { LivingMemorySnapshotCache } from '../../memory/snapshot/snapshot_cache'
import type { LivingMemoryAgenticRecallExecutor } from './agentic_recall'
import type {
    JobRepository,
    LivingMemoryConfig,
    SnapshotRepository
} from '../../../contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'

type LivingMemoryRecallCoordinatorConfig = Pick<
    LivingMemoryConfig,
    'recallStrategy' | 'recallTopK'
>

type RecallQueryBuilder = Pick<LivingMemoryRecallQueryBuilder, 'resolve'>
type RecallRetriever = Pick<LivingMemoryRetriever, 'retrieve'>
type RecallAgenticExecutor = Pick<LivingMemoryAgenticRecallExecutor, 'run'>
type RecallSnapshotCache = Pick<LivingMemorySnapshotCache, 'hydrate'>
type RecallJobTracker = Pick<
    LivingMemoryJobTracker,
    'markRunning' | 'markCompleted' | 'markFailed'
>
type RecallLogger = Pick<Logger, 'warn'>

export type RecallWorkflowRepository = Pick<JobRepository, 'createJob'> &
    Pick<SnapshotRepository, 'upsertSnapshot'>

export class LivingMemoryRecallCoordinator {
    private readonly recallLockByConversation = new Set<string>()

    constructor(
        private readonly config: LivingMemoryRecallCoordinatorConfig,
        private readonly repository: RecallWorkflowRepository,
        private readonly recallQuery: RecallQueryBuilder,
        private readonly retriever: RecallRetriever,
        private readonly agenticRecall: RecallAgenticExecutor,
        private readonly snapshotCache: RecallSnapshotCache,
        private readonly jobTracker: RecallJobTracker,
        private readonly logger: RecallLogger,
        private readonly debug: DebugLogger
    ) {}

    async queue(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>
    ) {
        const lockKey = scopeKey(scope)
        if (this.recallLockByConversation.has(lockKey)) {
            // 同一会话同一预设已有召回在跑，本次请求直接丢弃，不做 coalescing。
            // snapshot 由后续请求基于最新历史消息重新触发追上，最多滞后一轮。
            this.debug(
                [
                    `memory recall skipped: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    'reason=recall-in-progress'
                ].join(' ')
            )
            return
        }

        this.recallLockByConversation.add(lockKey)

        this.run(scope, currentMessage, loadHistoryMessages)
            .catch((error) => {
                this.logger.warn(error)
            })
            .finally(() => {
                this.recallLockByConversation.delete(lockKey)
            })
    }

    private async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>
    ) {
        let historyMessages: LivingMemoryTranscriptMessage[] = []
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

        if (this.config.recallStrategy === 'agentic-recall') {
            await this.runAgentic(scope, currentMessage, historyMessages)
            return
        }

        await this.runEmbeddingRerank(scope, currentMessage, historyMessages)
    }

    private async runEmbeddingRerank(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ) {
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

        const job = await this.repository.createJob(
            scope,
            'recall',
            input,
            'embedding-rerank'
        )

        try {
            await this.jobTracker.markRunning(job.id)

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
                'embedding-rerank',
                input,
                items.map((item) => ({
                    memoryId: item.id,
                    score: item.score
                }))
            )
            await this.snapshotCache.hydrate(scope)

            await this.jobTracker.markCompleted(
                job.id,
                `matched ${items.length} memories`
            )
        } catch (error) {
            await this.jobTracker.markFailed(job.id, error)
            throw error
        }
    }

    private async runAgentic(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ) {
        const input = normalizeText(currentMessage.contentLines.join('\n'))
        if (input.length === 0) {
            return
        }

        const job = await this.repository.createJob(
            scope,
            'recall',
            input,
            'agentic-recall'
        )

        try {
            await this.jobTracker.markRunning(job.id)

            const trace = await this.agenticRecall.run(
                scope,
                currentMessage,
                historyMessages
            )
            const matchedCount = trace.item.matchedMemories.length

            if (trace.item.finalText.trim().length === 0) {
                this.debug(
                    [
                        `memory agentic recall no memory selected: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `matched=${matchedCount}`,
                        'snapshot=unchanged'
                    ].join(' ')
                )
                await this.jobTracker.markCompleted(
                    job.id,
                    'no memory selected; snapshot unchanged'
                )
                return
            }

            const query = JSON.stringify(trace.item.toolCallSummary)
            await this.repository.upsertSnapshot(
                scope,
                'agentic-recall',
                query,
                [trace.item]
            )
            await this.snapshotCache.hydrate(scope)

            await this.jobTracker.markCompleted(
                job.id,
                `matched ${matchedCount} memories`
            )
        } catch (error) {
            await this.jobTracker.markFailed(job.id, error)
            throw error
        }
    }
}
