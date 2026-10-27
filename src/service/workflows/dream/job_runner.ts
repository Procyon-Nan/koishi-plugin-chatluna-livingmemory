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
            const outcomes = {
                completed: { event: 'Dream 完成', level: 'info' },
                partial: { event: 'Dream 部分完成', level: 'warn' },
                failed: { event: 'Dream 失败', level: 'error' }
            } as const
            const outcome = outcomes[result.status]
            const lines = [
                `预设：${scope.presetId}`,
                `处理记忆：${result.processedCount}/${result.entryCount} 条; 批次：${result.clusterCount} 批; 跳过：${result.skipped} 批`,
                `操作统计：检查 ${result.kept} 条; 合并 ${result.merged} 次; 拆分 ${result.split} 次; 更新 ${result.updated} 条; 归档 ${result.archived} 条（含合并、拆分来源）`
            ]
            if (result.error) lines.push(`原因：${result.error}`)
            logger.summary(outcome.event, lines, outcome.level)
        } catch (error) {
            let jobStateUpdateError: string | undefined
            try {
                await this.jobTracker.markFailed(jobId, error, detail)
            } catch (updateError) {
                jobStateUpdateError = formatErrorDetails(updateError)
            }
            logger.summary(
                'Dream 失败',
                `预设：${scope.presetId}; 任务：${jobId}` +
                    (jobStateUpdateError
                        ? `; 任务状态保存失败：${jobStateUpdateError}`
                        : ''),
                'error',
                error
            )
            throw error
        }
    }
}
