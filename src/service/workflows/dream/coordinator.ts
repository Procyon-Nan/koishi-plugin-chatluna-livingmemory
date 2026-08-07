import type { Logger } from 'koishi'
import type { LivingMemoryDreamJobRunner } from './job_runner'
import type { DebugLogger } from '../../memory/helpers'
import type {
    DreamTriggerResult,
    JobRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import type { MemoryScope } from '../../../contracts/memory'

type LivingMemoryDreamCoordinatorConfig = Pick<
    LivingMemoryConfig,
    'autoDreamMemoryGrowthThreshold' | 'enableAutoDream'
>

type DreamJobRunner = Pick<
    LivingMemoryDreamJobRunner,
    'runManual' | 'runAutomatic'
>
type DreamLogger = Pick<Logger, 'warn'>
type DreamTrigger = 'manual' | 'automatic'

type DreamRunLock = { phase: 'starting' } | { phase: 'running'; jobId: string }

export type DreamCoordinatorRepository = Pick<
    JobRepository,
    'createJob' | 'markStaleRunningJobsAsFailed'
> & {
    countPendingEntries(presetId: string): Promise<number>
}

export class LivingMemoryDreamCoordinator {
    private readonly lockByPreset = new Map<string, DreamRunLock>()

    constructor(
        private readonly config: LivingMemoryDreamCoordinatorConfig,
        private readonly jobRunner: DreamJobRunner,
        private readonly repository: DreamCoordinatorRepository,
        private readonly logger: DreamLogger,
        private readonly debug: DebugLogger
    ) {}

    async queueAutoIfThresholdReached(presetId: string) {
        if (!this.config.enableAutoDream) {
            return
        }
        if (this.lockByPreset.has(presetId)) {
            return
        }

        const pendingCount = await this.repository.countPendingEntries(presetId)
        const threshold = this.config.autoDreamMemoryGrowthThreshold

        if (pendingCount < threshold) {
            this.debug(
                [
                    'memory auto dream skipped:',
                    `presetId=${presetId}`,
                    `pending=${pendingCount}`,
                    `threshold=${threshold}`
                ].join(' ')
            )
            return
        }

        this.debug(
            [
                'memory auto dream threshold reached:',
                `presetId=${presetId}`,
                `pending=${pendingCount}`,
                `threshold=${threshold}`
            ].join(' ')
        )
        await this.startJob(presetId, 'automatic')
    }

    runManual(presetId: string): Promise<DreamTriggerResult> {
        return this.startJob(presetId, 'manual')
    }

    private async startJob(
        presetId: string,
        trigger: DreamTrigger
    ): Promise<DreamTriggerResult> {
        const currentLock = this.lockByPreset.get(presetId)
        if (currentLock !== undefined) {
            if (currentLock.phase === 'running') {
                return {
                    success: true,
                    started: false,
                    reason: 'preset-locked',
                    runningJobId: currentLock.jobId
                }
            }
            return {
                success: true,
                started: false,
                reason: 'preset-locked'
            }
        }

        this.lockByPreset.set(presetId, { phase: 'starting' })

        try {
            await this.recoverStaleJobs(presetId)

            const scope: MemoryScope = {
                conversationId: `dream:${trigger}:${presetId}`,
                presetId
            }
            let jobInput = `manual:${presetId}`
            if (trigger === 'automatic') {
                jobInput = `automatic-incremental:threshold=${this.config.autoDreamMemoryGrowthThreshold}`
            }
            const job = await this.repository.createJob(
                scope,
                'dream',
                jobInput
            )

            this.lockByPreset.set(presetId, {
                phase: 'running',
                jobId: job.id
            })
            this.runJob(scope, job.id, trigger)
                .catch((error) => {
                    this.logger.warn(error)
                })
                .finally(() => {
                    this.lockByPreset.delete(presetId)
                })

            return {
                success: true,
                started: true
            }
        } catch (error) {
            this.lockByPreset.delete(presetId)
            throw error
        }
    }

    private runJob(scope: MemoryScope, jobId: string, trigger: DreamTrigger) {
        if (trigger === 'manual') {
            return this.jobRunner.runManual(scope, jobId)
        }
        return this.jobRunner.runAutomatic(
            scope,
            jobId,
            this.config.autoDreamMemoryGrowthThreshold
        )
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
}
