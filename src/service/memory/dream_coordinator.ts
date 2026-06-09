import { Logger } from 'koishi'
import { LivingMemoryRepository } from '../repository'
import { LivingMemoryDreamService } from '../dream'
import { type DebugLogger } from './helpers'
import { LivingMemoryJobTracker } from './job_tracker'
import { LivingMemorySnapshotCache } from './snapshot_cache'
import type { DreamTriggerResult, MemoryScope } from '../../types'

export class LivingMemoryDreamCoordinator {
    private readonly dreamLockByPreset = new Map<string, string>()

    constructor(
        private readonly dream: LivingMemoryDreamService,
        private readonly repository: LivingMemoryRepository,
        private readonly snapshotCache: LivingMemorySnapshotCache,
        private readonly jobTracker: LivingMemoryJobTracker,
        private readonly logger: Logger,
        private readonly debug: DebugLogger
    ) {}

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
