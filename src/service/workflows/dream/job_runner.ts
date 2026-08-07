import type { MemoryScope } from '../../../contracts/memory'
import type { DebugLogger } from '../../memory/helpers'
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
        private readonly debug: DebugLogger
    ) {}

    runManual(scope: MemoryScope, jobId: string) {
        return this.run(scope, jobId, 'manual', async () => ({
            success: true,
            result: await this.dream.run(scope.presetId)
        }))
    }

    runAutomatic(scope: MemoryScope, jobId: string, batchSize: number) {
        return this.run(scope, jobId, 'automatic', async () => {
            const result = await this.incrementalDream.run(
                scope.presetId,
                batchSize
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
        workflow: () => Promise<DreamJobOutcome>
    ) {
        await this.jobTracker.markRunning(jobId)

        let outcome: DreamJobOutcome
        try {
            outcome = await workflow()
        } catch (error) {
            this.clearSnapshotCache(scope.presetId, jobId)
            let detail: string | null = null
            if (trigger === 'automatic') {
                detail = `dream automatic incremental failed: ${summarizeError(error)}`
            }
            await this.jobTracker.markFailed(jobId, error, detail)
            throw error
        }

        const { result } = outcome
        this.debug(
            [
                `memory dream finished: jobId=${jobId}`,
                `presetId=${scope.presetId}`,
                `trigger=${trigger}`,
                result.detail
            ].join(' ')
        )

        if (hasMemoryChanges(result)) {
            this.clearSnapshotCache(scope.presetId, jobId)
        }
        if (outcome.success === true) {
            await this.jobTracker.markCompleted(jobId, result.detail)
        } else {
            await this.jobTracker.markFailed(
                jobId,
                outcome.error,
                result.detail
            )
        }
    }

    private clearSnapshotCache(presetId: string, jobId: string) {
        this.snapshotCache.clearByPreset(presetId)
        this.debug(
            [
                `memory dream cache cleared: jobId=${jobId}`,
                `presetId=${presetId}`
            ].join(' ')
        )
    }
}

const hasMemoryChanges = (result: DreamRunResult) =>
    result.merged > 0 ||
    result.updated > 0 ||
    result.archived > 0 ||
    result.deleted > 0
