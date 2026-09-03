import type { LivingMemoryDreamJobRunner } from './job_runner'
import type { LivingMemoryLogger } from '../../logging/logger'
import type {
    DreamTriggerResult,
    JobRepository,
    LivingMemoryConfig
} from '../../../contracts/workflows'
import type { MemoryScope } from '../../../contracts/memory'

/**
 * 启动 Dream 所需的最少活跃记忆条数。低于一个整理单元的规模时可归并的材料太
 * 少，整理收益抵不上一轮聚类与模型调用，因此两种触发方式都不启动任务。取值与
 * 手动 Dream 的单元簇上限 DREAM_CLUSTER_UNIT_MAX_SIZE、增量 Dream 每个种子的
 * 邻居数上限 INCREMENTAL_DREAM_TOP_K 一致。
 */
const DREAM_MIN_ACTIVE_MEMORY_COUNT = 30

type LivingMemoryDreamCoordinatorConfig = Pick<
    LivingMemoryConfig,
    'autoDreamMemoryGrowthThreshold' | 'enableAutoDream'
>

type DreamJobRunner = Pick<
    LivingMemoryDreamJobRunner,
    'runManual' | 'runAutomatic'
>
type DreamTrigger = 'manual' | 'automatic'

type DreamRunLock = { phase: 'starting' } | { phase: 'running'; jobId: string }

export type DreamCoordinatorRepository = Pick<
    JobRepository,
    'createJob' | 'markStaleRunningJobsAsFailed'
> & {
    countActiveEntries(presetId: string): Promise<number>
    countPendingEntries(presetId: string): Promise<number>
}

export class LivingMemoryDreamCoordinator {
    private readonly lockByPreset = new Map<string, DreamRunLock>()

    constructor(
        private readonly config: LivingMemoryDreamCoordinatorConfig,
        private readonly jobRunner: DreamJobRunner,
        private readonly repository: DreamCoordinatorRepository,
        private readonly logger: LivingMemoryLogger
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
            this.logger.diagnostic('dream.automatic.skipped', {
                workflow: 'dream',
                presetId,
                pending: pendingCount,
                threshold,
                reason: 'threshold-not-reached'
            })
            return
        }

        const activeCount = await this.repository.countActiveEntries(presetId)
        if (activeCount < DREAM_MIN_ACTIVE_MEMORY_COUNT) {
            this.logger.diagnostic('dream.automatic.skipped', {
                workflow: 'dream',
                presetId,
                active: activeCount,
                minimum: DREAM_MIN_ACTIVE_MEMORY_COUNT,
                reason: 'insufficient-memories'
            })
            return
        }

        this.logger.diagnostic('dream.automatic.threshold-reached', {
            workflow: 'dream',
            presetId,
            pending: pendingCount,
            threshold
        })
        await this.startJob(presetId, 'automatic')
    }

    async runManual(presetId: string): Promise<DreamTriggerResult> {
        const activeCount = await this.repository.countActiveEntries(presetId)
        if (activeCount < DREAM_MIN_ACTIVE_MEMORY_COUNT) {
            return {
                success: true,
                started: false,
                reason: 'insufficient-memories'
            }
        }
        return await this.startJob(presetId, 'manual')
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
                .catch(() => {})
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
            this.logger.diagnostic('dream.stale-jobs.recovered', {
                workflow: 'dream',
                presetId,
                count: recovered.length
            })
        }
    }
}
