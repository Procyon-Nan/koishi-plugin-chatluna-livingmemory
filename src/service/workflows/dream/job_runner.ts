import type { MemoryScope } from '../../../contracts/memory'
import type { LivingMemoryLogger } from '../../logging/logger'
import { summarizeError } from '../../shared/utils'
import type { LivingMemorySnapshotCache } from '../../memory/snapshot/snapshot_cache'
import type { LivingMemoryJobTracker } from '../job_tracker'
import type { LivingMemoryIncrementalDreamService } from './incremental'
import type { LivingMemoryDreamService } from './index'
import type { DreamRunResult } from './types'

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
        await this.jobTracker.markRunning(jobId)
        const jobLogger = this.logger.with({
            workflow: 'dream',
            jobId,
            presetId: scope.presetId,
            trigger
        })
        jobLogger.info('dream.started')

        let outcome: DreamJobOutcome
        try {
            outcome = await workflow(jobLogger)
        } catch (error) {
            this.clearSnapshotCache(scope.presetId, jobId)
            let detail: string | null = null
            if (trigger === 'automatic') {
                detail = `dream automatic incremental failed: ${summarizeError(error)}`
            }
            await this.jobTracker.markFailed(jobId, error, detail)
            jobLogger.warn('dream.failed', { detail }, error)
            throw error
        }

        const { result } = outcome
        if (hasMemoryChanges(result)) {
            this.clearSnapshotCache(scope.presetId, jobId)
        }
        if (outcome.success === true) {
            await this.jobTracker.markCompleted(jobId, result.detail)
            jobLogger.info('dream.completed', {
                entries: result.entryCount,
                clusters: result.clusterCount,
                kept: result.kept,
                merged: result.merged,
                updated: result.updated,
                archived: result.archived,
                deleted: result.deleted,
                skipped: result.skipped
            })
        } else {
            await this.jobTracker.markFailed(
                jobId,
                outcome.error,
                result.detail
            )
            jobLogger.warn('dream.failed', {
                error: outcome.error,
                detail: result.detail
            })
        }
    }

    private clearSnapshotCache(presetId: string, jobId: string) {
        this.snapshotCache.clearByPreset(presetId)
        this.logger.diagnostic('dream.snapshot-cache.cleared', {
            workflow: 'dream',
            jobId,
            presetId
        })
    }
}

const hasMemoryChanges = (result: DreamRunResult) =>
    result.merged > 0 ||
    result.updated > 0 ||
    result.archived > 0 ||
    result.deleted > 0
