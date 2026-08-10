import type { Logger } from 'koishi'
import type { LivingMemoryRetriever } from './retriever'
import type { LivingMemoryRecallQueryBuilder } from './query_builder'
import { summarizeError } from '../../shared/utils'
import { type DebugLogger, normalizeText, scopeKey } from '../../memory/helpers'
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
type RecallLogger = Pick<Logger, 'warn'>

export type RecallWorkflowRepository = Pick<JobRepository, 'createFailedJob'> &
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
            this.debug(() =>
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
                this.logger.warn(
                    [
                        'memory background operation failed:',
                        'workflow=recall',
                        'operation=run',
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`
                    ].join(' '),
                    error
                )
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
            this.debug(() =>
                [
                    `memory recall history unavailable: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `errorLength=${summarizeError(error).length}`
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
        const startedAt = new Date()
        let input = normalizeText(currentMessage.contentLines.join('\n'))

        try {
            const query = await this.recallQuery.resolve(
                scope,
                currentMessage,
                historyMessages
            )

            this.debug(() =>
                [
                    `memory recall query prepared: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `rawInputLength=${query.rawInputLength}`,
                    `cleanedQueryLength=${query.cleanedQuery.length}`,
                    `finalQueryLength=${query.finalQuery.length}`
                ].join(' ')
            )
            if (query.skippedReason != null) {
                this.debug(() =>
                    [
                        `memory recall skipped: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `reason=${query.skippedReason}`
                    ].join(' ')
                )
                return
            }

            const rewritePrompt = query.rewritePrompt
            if (rewritePrompt != null) {
                this.debug(() =>
                    [
                        `memory recall rewrite input prepared: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `systemPromptLength=${rewritePrompt.systemPrompt.length}`,
                        `inputPromptLength=${rewritePrompt.inputPrompt.length}`
                    ].join(' ')
                )
            }

            const rewriteOutput = query.rewriteOutput
            if (rewriteOutput != null) {
                this.debug(() =>
                    [
                        `memory recall rewrite output received: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `outputLength=${rewriteOutput.length}`
                    ].join(' ')
                )
            }

            if (query.fallbackReason != null) {
                const fallbackError = query.error
                this.debug(() => {
                    const details = [
                        `memory recall rewrite fallback: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `reason=${query.fallbackReason}`
                    ]
                    if (fallbackError != null) {
                        details.push(`errorLength=${fallbackError.length}`)
                    }
                    details.push(`finalQueryLength=${query.finalQuery.length}`)
                    return details.join(' ')
                })
            }

            input = normalizeText(query.finalQuery)
            if (input.length === 0) {
                return
            }

            const items = await this.retriever.retrieve(
                scope.presetId,
                input,
                this.config.recallTopK
            )
            this.debug(() =>
                [
                    `memory recall: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `queryLength=${input.length}`,
                    `count=${items.length}`
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
        } catch (error) {
            await this.repository.createFailedJob(
                scope,
                'recall',
                input,
                error,
                startedAt,
                'embedding-rerank'
            )
            throw error
        }
    }

    private async runAgentic(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ) {
        const startedAt = new Date()
        const input = normalizeText(currentMessage.contentLines.join('\n'))
        if (input.length === 0) {
            return
        }

        try {
            const trace = await this.agenticRecall.run(
                scope,
                currentMessage,
                historyMessages
            )
            const matchedCount = trace.item.matchedMemories.length

            if (trace.item.finalText.trim().length === 0) {
                this.debug(() =>
                    [
                        `memory agentic recall no memory selected: conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `matched=${matchedCount}`,
                        'snapshot=unchanged'
                    ].join(' ')
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
        } catch (error) {
            await this.repository.createFailedJob(
                scope,
                'recall',
                input,
                error,
                startedAt,
                'agentic-recall'
            )
            throw error
        }
    }
}
