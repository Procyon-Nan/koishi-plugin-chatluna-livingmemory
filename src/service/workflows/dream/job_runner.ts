import type { MemoryScope } from '../../../contracts/memory'
import type { LivingMemoryLogger } from '../../logging/logger'
import { formatErrorDetails } from '../../shared/utils'
import type { LivingMemoryJobTracker } from '../job_tracker'
import type { LivingMemoryDreamService } from './service'

export class LivingMemoryDreamJobRunner {
    constructor(
        private readonly dream: Pick<LivingMemoryDreamService, 'run'>,
        private readonly jobTracker: Pick<
            LivingMemoryJobTracker,
            'markRunning' | 'markCompleted' | 'markFailed'
        >,
        private readonly logger: LivingMemoryLogger
    ) {}

    async run(scope: MemoryScope, jobId: string, signal?: AbortSignal) {
        const logger = this.logger.with({
            workflow: 'dream',
            jobId,
            presetId: scope.presetId
        })
        let detail: string | null = null
        try {
            await this.jobTracker.markRunning(jobId)
            logger.summary('Dream 开始', `预设：${scope.presetId}`)
            const result = await this.dream.run(
                scope.presetId,
                jobId,
                logger,
                signal
            )
            detail = result.detail
            if (result.status === 'failed') {
                await this.jobTracker.markFailed(
                    jobId,
                    result.error ?? 'Dream 没有成功处理目标记忆。',
                    detail
                )
            } else {
                await this.jobTracker.markCompleted(
                    jobId,
                    detail,
                    result.status
                )
            }
            const level = result.status === 'failed' ? 'warn' : 'info'
            logger[level](`dream.${result.status}`, {
                entries: result.entryCount,
                processed: result.processedCount,
                clusters: result.clusterCount,
                kept: result.kept,
                merged: result.merged,
                split: result.split,
                updated: result.updated,
                archived: result.archived,
                skipped: result.skipped,
                error: result.error
            })
        } catch (error) {
            let jobStateUpdateError: string | undefined
            try {
                await this.jobTracker.markFailed(jobId, error, detail)
            } catch (updateError) {
                jobStateUpdateError = formatErrorDetails(updateError)
            }
            logger.warn('dream.failed', { detail, jobStateUpdateError }, error)
            throw error
        }
    }
}
