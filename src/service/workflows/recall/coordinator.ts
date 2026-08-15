import { randomUUID } from 'node:crypto'
import type { LivingMemoryRetriever } from './retriever'
import type { LivingMemoryRecallQueryBuilder } from './query_builder'
import { summarizeError } from '../../shared/utils'
import { normalizeText, scopeKey } from '../../memory/helpers'
import type { LivingMemoryLogger } from '../../logging/logger'
import type { LivingMemorySnapshotCache } from '../../memory/snapshot/snapshot_cache'
import type { LivingMemoryAgenticRecallExecutor } from './agentic_recall'
import type {
    JobRepository,
    LivingMemoryConfig,
    SnapshotRepository
} from '../../../contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryRecallStrategy,
    MemoryScope,
    MemorySnapshotItem
} from '../../../contracts/memory'

type LivingMemoryRecallCoordinatorConfig = Pick<
    LivingMemoryConfig,
    'recallStrategy' | 'recallTopK'
>

type RecallQueryBuilder = Pick<LivingMemoryRecallQueryBuilder, 'resolve'>
type RecallRetriever = Pick<LivingMemoryRetriever, 'retrieve'>
type RecallAgenticExecutor = Pick<LivingMemoryAgenticRecallExecutor, 'run'>
type RecallSnapshotCache = Pick<LivingMemorySnapshotCache, 'hydrate'>
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
        private readonly logger: LivingMemoryLogger
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
            this.logger.diagnostic('recall.skipped', {
                workflow: 'recall',
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                reason: 'recall-in-progress'
            })
            return
        }

        this.recallLockByConversation.add(lockKey)

        const runLogger = this.logger.with({
            workflow: 'recall',
            runId: randomUUID(),
            conversationId: scope.conversationId,
            presetId: scope.presetId
        })
        this.run(scope, currentMessage, loadHistoryMessages, runLogger)
            .catch((error) => {
                runLogger.warn('recall.failed', { operation: 'run' }, error)
            })
            .finally(() => {
                this.recallLockByConversation.delete(lockKey)
            })
    }

    private async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>,
        logger: LivingMemoryLogger
    ) {
        let historyMessages: LivingMemoryTranscriptMessage[] = []
        try {
            historyMessages = await loadHistoryMessages()
        } catch (error) {
            logger.diagnostic('recall.history.unavailable', {
                error: summarizeError(error)
            })
        }

        if (this.config.recallStrategy === 'agentic-recall') {
            await this.runAgentic(
                scope,
                currentMessage,
                historyMessages,
                logger
            )
            return
        }

        await this.runEmbeddingRerank(
            scope,
            currentMessage,
            historyMessages,
            logger
        )
    }

    private async runEmbeddingRerank(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[],
        logger: LivingMemoryLogger
    ) {
        const startedAt = new Date()
        let input = normalizeText(currentMessage.contentLines.join('\n'))

        try {
            const query = await this.recallQuery.resolve(
                scope,
                currentMessage,
                historyMessages,
                logger
            )

            logger.diagnostic('recall.query.prepared', {
                rawInputLength: query.rawInputLength,
                cleanedQueryLength: query.cleanedQuery.length,
                finalQueryLength: query.finalQuery.length
            })
            if (query.skippedReason != null) {
                logger.diagnostic('recall.skipped', {
                    reason: query.skippedReason
                })
                return
            }

            if (query.fallbackReason != null) {
                const fallbackError = query.error
                logger.diagnostic('recall.query.fallback', {
                    reason: query.fallbackReason,
                    error: fallbackError,
                    finalQueryLength: query.finalQuery.length
                })
            }

            input = normalizeText(query.finalQuery)
            if (input.length === 0) {
                return
            }

            const items = await this.retriever.retrieve(
                scope.presetId,
                input,
                this.config.recallTopK,
                logger
            )
            logger.diagnostic('recall.retrieval.completed', {
                queryLength: input.length,
                count: items.length
            })
            if (items.length === 0) {
                logger.info('recall.snapshot.unchanged', {
                    strategy: 'embedding-rerank',
                    reason: 'no-memory-selected'
                })
                return
            }
            await this.persistSnapshot(
                scope,
                'embedding-rerank',
                input,
                items.map((item) => ({
                    memoryId: item.id,
                    score: item.score
                })),
                logger
            )
        } catch (error) {
            await this.recordFailedRecall(
                scope,
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
        historyMessages: LivingMemoryTranscriptMessage[],
        logger: LivingMemoryLogger
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
                historyMessages,
                logger
            )
            const matchedCount = trace.item.matchedMemories.length

            if (trace.item.finalText.trim().length === 0) {
                logger.info('recall.snapshot.unchanged', {
                    strategy: 'agentic-recall',
                    reason: 'no-memory-selected',
                    matched: matchedCount
                })
                return
            }

            const query = JSON.stringify(trace.item.toolCallSummary)
            await this.persistSnapshot(
                scope,
                'agentic-recall',
                query,
                [trace.item],
                logger,
                { matched: matchedCount }
            )
        } catch (error) {
            await this.recordFailedRecall(
                scope,
                input,
                error,
                startedAt,
                'agentic-recall'
            )
            throw error
        }
    }

    private async persistSnapshot(
        scope: MemoryScope,
        strategy: MemoryRecallStrategy,
        query: string,
        items: MemorySnapshotItem[],
        logger: LivingMemoryLogger,
        extraFields: Record<string, unknown> = {}
    ) {
        await this.repository.upsertSnapshot(scope, strategy, query, items)
        const content = await this.snapshotCache.hydrate(scope)
        logger.info('recall.snapshot.updated', {
            strategy,
            content,
            ...extraFields
        })
    }

    private async recordFailedRecall(
        scope: MemoryScope,
        input: string,
        error: unknown,
        startedAt: Date,
        strategy: MemoryRecallStrategy
    ) {
        await this.repository.createFailedJob(
            scope,
            'recall',
            input,
            error,
            startedAt,
            strategy
        )
    }
}
