import type { LivingMemoryDreamJobRunner } from './job_runner'
import type { LivingMemoryLogger } from '../../logging/logger'
import type {
    DreamTriggerResult,
    JobRepository
} from '../../../contracts/workflows'
import type { MemoryScope } from '../../../contracts/memory'

const DREAM_MIN_ACTIVE_MEMORY_COUNT = 30

type DreamRunLock = { phase: 'starting' } | { phase: 'running'; jobId: string }
export type DreamCoordinatorRepository = Pick<
    JobRepository,
    'createJob' | 'markStaleRunningJobsAsFailed'
> & {
    countActiveEntries(presetId: string): Promise<number>
}

export class LivingMemoryDreamCoordinator {
    private readonly lockByPreset = new Map<string, DreamRunLock>()
    private readonly controller = new AbortController()
    private readonly tasks = new Set<Promise<unknown>>()

    constructor(
        private readonly jobRunner: Pick<LivingMemoryDreamJobRunner, 'run'>,
        private readonly repository: DreamCoordinatorRepository,
        private readonly logger: LivingMemoryLogger
    ) {}

    start(presetId: string): Promise<DreamTriggerResult> {
        this.controller.signal.throwIfAborted()
        return this.track(this.startJob(presetId))
    }

    async stop() {
        this.controller.abort(new Error('Dream 服务正在停止。'))
        // 启动中的任务可能刚创建任务记录；一并等待它落下终态后再关闭 Worker。
        while (this.tasks.size > 0) {
            await Promise.allSettled([...this.tasks])
        }
    }

    private track<T>(task: Promise<T>) {
        this.tasks.add(task)
        const remove = () => {
            this.tasks.delete(task)
        }
        void task.then(remove, remove)
        return task
    }

    private async startJob(presetId: string): Promise<DreamTriggerResult> {
        const current = this.lockByPreset.get(presetId)
        if (current !== undefined) {
            return {
                success: true,
                started: false,
                reason: 'preset-locked',
                runningJobId:
                    current.phase === 'running' ? current.jobId : undefined
            }
        }
        this.lockByPreset.set(presetId, { phase: 'starting' })
        let running = false
        try {
            const activeCount =
                await this.repository.countActiveEntries(presetId)
            this.controller.signal.throwIfAborted()
            if (activeCount < DREAM_MIN_ACTIVE_MEMORY_COUNT) {
                return {
                    success: true,
                    started: false,
                    reason: 'insufficient-memories'
                }
            }
            const recovered =
                await this.repository.markStaleRunningJobsAsFailed(
                    { presetId, kind: 'dream' },
                    'dream recovered: stale running job'
                )
            if (recovered.length > 0) {
                this.logger.diagnosticSummary(() => ({
                    event: 'Dream 中断任务状态恢复完成',
                    detail: `预设：${presetId}; 标记失败：${recovered.length} 个任务`
                }))
            }
            this.controller.signal.throwIfAborted()
            const scope: MemoryScope = {
                conversationId: `dream:manual:${presetId}`,
                presetId
            }
            const job = await this.repository.createJob(
                scope,
                'dream',
                `manual:${presetId}`
            )
            this.lockByPreset.set(presetId, { phase: 'running', jobId: job.id })
            running = true
            void this.track(
                this.jobRunner
                    .run(scope, job.id, this.controller.signal)
                    .finally(() => {
                        this.lockByPreset.delete(presetId)
                    })
            )
            return { success: true, started: true }
        } finally {
            if (!running) this.lockByPreset.delete(presetId)
        }
    }
}
