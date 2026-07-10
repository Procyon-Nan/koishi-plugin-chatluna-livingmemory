import { Logger } from 'koishi'
import { LivingMemoryDreamService } from './index'
import { isModelConfigured } from '../../shared/utils'
import { type DebugLogger } from '../../memory/helpers'
import { LivingMemoryJobTracker } from '../job_tracker'
import { LivingMemorySnapshotCache } from '../../memory/snapshot/snapshot_cache'
import type {
    DreamTriggerResult,
    JobRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import type { MemoryScope } from '../../../contracts/memory'

type LivingMemoryDreamCoordinatorConfig = Pick<
    LivingMemoryConfig,
    'autoDreamMemoryGrowthThreshold' | 'dreamModel' | 'enableAutoDream'
>

export type DreamCoordinatorRepository = Pick<
    JobRepository,
    'createJob' | 'getLatestJobByPresetAndKind' | 'markStaleRunningJobsAsFailed'
> & {
    countEntriesCreatedAfter(
        presetId: string,
        createdAfter?: Date
    ): Promise<number>
}

export class LivingMemoryDreamCoordinator {
    private readonly dreamLockByPreset = new Map<string, string>()

    constructor(
        private readonly config: LivingMemoryDreamCoordinatorConfig,
        private readonly dream: LivingMemoryDreamService,
        private readonly repository: DreamCoordinatorRepository,
        private readonly snapshotCache: LivingMemorySnapshotCache,
        private readonly jobTracker: LivingMemoryJobTracker,
        private readonly logger: Logger,
        private readonly debug: DebugLogger
    ) {}

    async queueAutoIfThresholdReached(presetId: string) {
        if (!this.config.enableAutoDream) {
            return
        }

        if (!isModelConfigured(this.config.dreamModel)) {
            this.debug(
                [
                    'memory auto dream skipped:',
                    `presetId=${presetId}`,
                    'reason=model-not-configured'
                ].join(' ')
            )
            return
        }

        const latestDreamJob =
            await this.repository.getLatestJobByPresetAndKind(presetId, 'dream')
        const newMemoryCount = await this.repository.countEntriesCreatedAfter(
            presetId,
            latestDreamJob?.createdAt
        )
        const threshold = this.config.autoDreamMemoryGrowthThreshold

        if (newMemoryCount < threshold) {
            this.debug(
                [
                    'memory auto dream skipped:',
                    `presetId=${presetId}`,
                    `newMemories=${newMemoryCount}`,
                    `threshold=${threshold}`
                ].join(' ')
            )
            return
        }

        const result = await this.run(presetId)
        const reason = result.reason == null ? '' : ` reason=${result.reason}`
        this.debug(
            [
                'memory auto dream triggered:',
                `presetId=${presetId}`,
                `newMemories=${newMemoryCount}`,
                `threshold=${threshold}`,
                `started=${result.started}`
            ].join(' ') + reason
        )
    }

    async run(presetId: string): Promise<DreamTriggerResult> {
        if (this.dreamLockByPreset.has(presetId)) {
            const runningJobId = this.dreamLockByPreset.get(presetId)
            return {
                success: true,
                started: false,
                reason: 'preset-locked',
                runningJobId: runningJobId?.length ? runningJobId : undefined
            }
        }

        this.dreamLockByPreset.set(presetId, '')

        try {
            await this.recoverStaleJobs(presetId)

            const scope: MemoryScope = {
                conversationId: `dream:${presetId}`,
                presetId
            }
            const job = await this.repository.createJob(
                scope,
                'dream',
                presetId
            )

            this.dreamLockByPreset.set(presetId, job.id)
            this.runJob(scope, job.id)
                .catch((error) => {
                    this.logger.warn(error)
                })
                .finally(() => {
                    if (this.dreamLockByPreset.get(presetId) === job.id) {
                        this.dreamLockByPreset.delete(presetId)
                        this.queueAutoIfThresholdReached(presetId).catch(
                            (error) => {
                                this.logger.warn(error)
                            }
                        )
                    }
                })

            return {
                success: true,
                started: true
            }
        } catch (error) {
            if (this.dreamLockByPreset.get(presetId) === '') {
                this.dreamLockByPreset.delete(presetId)
            }
            throw error
        }
    }

    private async runJob(scope: MemoryScope, jobId: string) {
        try {
            await this.jobTracker.markRunning(jobId)
            const result = await this.dream.run(scope.presetId)
            this.debug(
                [
                    `memory dream completed: jobId=${jobId}`,
                    `presetId=${scope.presetId}`,
                    result.detail
                ].join(' ')
            )
            await this.jobTracker.markCompleted(jobId, result.detail)
            if (result.merged + result.updated + result.archived > 0) {
                this.refreshSnapshotCache(scope.presetId, jobId)
            }
        } catch (error) {
            await this.jobTracker.markFailed(jobId, error)
            throw error
        }
    }

    private async recoverStaleJobs(presetId: string) {
        const recovered = await this.repository.markStaleRunningJobsAsFailed(
            { presetId, kind: 'dream' },
            'dream recovered: stale running job'
        )
        if (recovered.length > 0) {
            this.debug(
                `memory dream stale jobs recovered: presetId=${presetId}, count=${recovered.length}`
            )
        }
    }

    private refreshSnapshotCache(presetId: string, jobId: string) {
        this.snapshotCache.clearByPreset(presetId)
        this.debug(
            [
                `memory dream cache cleared: jobId=${jobId}`,
                `presetId=${presetId}`
            ].join(' ')
        )
    }
}
