import type { MemoryScope } from '../../../contracts/memory'
import type { LivingMemoryLogger } from '../../logging/logger'
import { summarizeError } from '../../shared/utils'
import type { LivingMemorySnapshotCache } from '../../memory/snapshot/snapshot_cache'
import type { LivingMemoryJobTracker } from '../job_tracker'
import type { LivingMemoryIncrementalDreamService } from './incremental'
import type { LivingMemoryDreamService } from './index'
import type { DreamRunResult, DreamStageResult } from './types'

type DreamService = Pick<LivingMemoryDreamService, 'run'>
type IncrementalDreamService = Pick<LivingMemoryIncrementalDreamService, 'run'>
type DreamSnapshotCache = Pick<LivingMemorySnapshotCache, 'clearByPreset'>
type DreamJobTracker = Pick<
    LivingMemoryJobTracker,
    'markRunning' | 'markCompleted' | 'markFailed'
>

type DreamJobOutcome =
    | { success: true; result: DreamRunResult }
    | { success: false; result: DreamRunResult; error: string }

export class LivingMemoryDreamJobRunner {
    constructor(
        private readonly dream: DreamService,
        private readonly incrementalDream: IncrementalDreamService,
        private readonly snapshotCache: DreamSnapshotCache,
        private readonly jobTracker: DreamJobTracker,
        private readonly logger: LivingMemoryLogger
    ) {}

    runManual(scope: MemoryScope, jobId: string) {
        return this.run(scope, jobId, 'manual', async (logger) => ({
            success: true,
            result: await this.dream.run(scope.presetId, logger)
        }))
    }

    runAutomatic(scope: MemoryScope, jobId: string, batchSize: number) {
        return this.run(scope, jobId, 'automatic', async (logger) => {
            const result = await this.incrementalDream.run(
                scope.presetId,
                batchSize,
                logger
            )
            if (result.failed) {
                return {
                    success: false,
                    result,
                    error: 'automatic incremental dream failed'
                }
            }
            return {
                success: true,
                result
            }
        })
    }

    private async run(
        scope: MemoryScope,
        jobId: string,
        trigger: 'manual' | 'automatic',
        workflow: (logger?: LivingMemoryLogger) => Promise<DreamJobOutcome>
    ) {
        const jobLogger = this.logger.with({
            workflow: 'dream',
            jobId,
            presetId: scope.presetId,
            trigger
        })
        let workflowStarted = false
        let failureDetail: string | null = null
        let workflowFailure: unknown
        try {
            await this.jobTracker.markRunning(jobId)
            jobLogger.info('dream.started')
            workflowStarted = true

            const outcome = await workflow(jobLogger)
            const { result } = outcome
            if (hasMemoryChanges(result)) {
                this.clearSnapshotCache(scope.presetId)
            }
            if (outcome.success === true) {
                await this.jobTracker.markCompleted(jobId, result.detail)
                this.logCompletion(jobLogger, result)
                return
            }

            failureDetail = result.detail
            workflowFailure = outcome.error
            await this.jobTracker.markFailed(
                jobId,
                outcome.error,
                result.detail
            )
            jobLogger.warn('dream.failed', {
                error: outcome.error,
                detail: result.detail
            })
        } catch (error) {
            if (workflowStarted) {
                this.clearSnapshotCache(scope.presetId)
            }
            if (failureDetail == null && trigger === 'automatic') {
                failureDetail = `dream automatic incremental failed: ${summarizeError(error)}`
            }

            let jobStateUpdateError: string | undefined
            try {
                await this.jobTracker.markFailed(
                    jobId,
                    workflowFailure ?? error,
                    failureDetail
                )
            } catch (updateError) {
                jobStateUpdateError = summarizeError(updateError)
            }
            jobLogger.warn(
                'dream.failed',
                {
                    detail: failureDetail,
                    jobStateUpdateError,
                    workflowError: workflowFailure
                },
                error
            )
            throw error
        }
    }

    private logCompletion(logger: LivingMemoryLogger, result: DreamRunResult) {
        if (result.stageResults != null && result.stageResults.length > 0) {
            for (const stageResult of result.stageResults) {
                logger.info(
                    'dream.completed',
                    toStageCompletionFields(stageResult)
                )
            }
            return
        }

        logger.info('dream.completed', {
            entries: result.entryCount,
            clusters: result.clusterCount,
            kept: result.kept,
            merged: result.merged,
            updated: result.updated,
            archived: result.archived,
            deleted: result.deleted,
            skipped: result.skipped
        })
    }

    private clearSnapshotCache(presetId: string) {
        this.snapshotCache.clearByPreset(presetId)
    }
}

const toStageCompletionFields = (result: DreamStageResult) => {
    const fields = {
        stage: result.stage,
        entries: result.entryCount,
        clusters: result.clusterCount,
        kept: result.kept,
        merged: result.merged,
        updated: result.updated,
        skipped: result.skipped
    }
    return result.stage === 'active'
        ? { ...fields, archived: result.archived }
        : { ...fields, deleted: result.deleted }
}

const hasMemoryChanges = (result: DreamRunResult) =>
    result.merged > 0 ||
    result.updated > 0 ||
    result.archived > 0 ||
    result.deleted > 0
