import { randomUUID } from 'node:crypto'
import { isModelConfigured, summarizeError } from '../../shared/utils'
import { normalizeText, scopeKey } from '../../memory/helpers'
import type { LivingMemoryLogger } from '../../logging/logger'
import type { LivingMemorySnapshotCache } from '../../memory/snapshot/snapshot_cache'
import type { LivingMemoryAgenticRecallExecutor } from './agentic_recall'
import type {
    JobRepository,
    LivingMemoryConfig,
    SnapshotRepository
} from '../../../contracts/workflows'
import type { MessageLogRegistry } from '../../transcript/message_log/message_log_registry'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'

type LivingMemoryRecallCoordinatorConfig = Pick<
    LivingMemoryConfig,
    'recallIntervalMessages' | 'subModel'
>

/** 召回间隔锚点所需的消息日志读取面。 */
type RecallMessageLog = Pick<MessageLogRegistry, 'tailSeq'>

type RecallAgenticExecutor = Pick<LivingMemoryAgenticRecallExecutor, 'run'>
type RecallSnapshotCache = Pick<LivingMemorySnapshotCache, 'hydrate'>
export type RecallWorkflowRepository = Pick<JobRepository, 'createFailedJob'> &
    Pick<SnapshotRepository, 'upsertSnapshot'>

export class LivingMemoryRecallCoordinator {
    private readonly recallLockByConversation = new Set<string>()
    /**
     * 召回窗口锚点：上次实际执行召回时点的日志末序号。间隔按此后累计
     * 进入日志的消息条数（含闲聊）计；锚点只在召回实际执行时前移。
     */
    private readonly anchorSeqByScope = new Map<string, number>()

    constructor(
        private readonly config: LivingMemoryRecallCoordinatorConfig,
        private readonly messageLog: RecallMessageLog,
        private readonly repository: RecallWorkflowRepository,
        private readonly agenticRecall: RecallAgenticExecutor,
        private readonly snapshotCache: RecallSnapshotCache,
        private readonly logger: LivingMemoryLogger
    ) {}

    async queue(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>
    ) {
        const disabledReason =
            this.config.recallIntervalMessages === 0
                ? 'disabled'
                : !isModelConfigured(this.config.subModel)
                  ? 'model-not-configured'
                  : null
        if (disabledReason != null) {
            this.logger.diagnostic('recall.skipped', {
                workflow: 'recall',
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                reason: disabledReason
            })
            return
        }

        const lockKey = scopeKey(scope)
        const anchorSeq = this.anchorSeqByScope.get(lockKey)
        if (anchorSeq !== undefined) {
            const tailSeq = this.messageLog.tailSeq(scope.conversationId)
            const messagesSinceRecall =
                tailSeq == null ? 0 : tailSeq - anchorSeq
            if (messagesSinceRecall < this.config.recallIntervalMessages) {
                this.logger.diagnostic('recall.skipped', {
                    workflow: 'recall',
                    conversationId: scope.conversationId,
                    presetId: scope.presetId,
                    reason: 'recall-interval',
                    messagesRemaining:
                        this.config.recallIntervalMessages - messagesSinceRecall
                })
                return
            }
        }

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

        this.anchorSeqByScope.set(
            lockKey,
            this.messageLog.tailSeq(scope.conversationId) ?? 0
        )
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

    clearAll() {
        this.anchorSeqByScope.clear()
    }

    clearByConversation(conversationId: string) {
        for (const key of this.anchorSeqByScope.keys()) {
            if (key.endsWith(`\n${conversationId}`)) {
                this.anchorSeqByScope.delete(key)
            }
        }
    }

    private async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        loadHistoryMessages: () => Promise<LivingMemoryTranscriptMessage[]>,
        logger: LivingMemoryLogger
    ) {
        const startedAt = new Date()
        const input = normalizeText(currentMessage.contentLines.join('\n'))
        if (input.length === 0) {
            return
        }

        let historyMessages: LivingMemoryTranscriptMessage[] = []
        try {
            historyMessages = await loadHistoryMessages()
        } catch (error) {
            logger.diagnostic('recall.history.unavailable', {
                error: summarizeError(error)
            })
        }

        try {
            const trace = await this.agenticRecall.run(
                scope,
                currentMessage,
                historyMessages,
                logger
            )
            if (trace == null) {
                logger.info('recall.snapshot.unchanged', {
                    reason: 'no-memory-selected'
                })
                return
            }

            await this.repository.upsertSnapshot(
                scope,
                JSON.stringify(trace.item.toolCallSummary),
                [trace.item]
            )
            const content = await this.snapshotCache.hydrate(scope)
            logger.info(
                'recall.snapshot.updated',
                { matched: trace.item.matchedMemories.length },
                [
                    {
                        title: 'snapshot.content',
                        key: 'content',
                        value: content
                    }
                ]
            )
        } catch (error) {
            await this.repository.createFailedJob(
                scope,
                'recall',
                input,
                error,
                startedAt
            )
            throw error
        }
    }
}
