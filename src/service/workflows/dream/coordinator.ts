import type { LivingMemoryDreamJobRunner } from './job_runner'
import type { LivingMemoryLogger } from '../../logging/logger'
import type {
    DreamTriggerResult,
    JobRepository
} from '../../../contracts/workflows'
import type { MemoryScope } from '../../../contracts/memory'
import { SerialTaskQueue } from '../../shared/serial_task_queue'
import type { DreamRunInput } from './types'

const DREAM_MIN_ACTIVE_MEMORY_COUNT = 30

export type DreamCoordinatorRepository = Pick<
    JobRepository,
    'createJob' | 'markStaleRunningJobsAsFailed'
> & {
    countActiveEntries(presetId: string): Promise<number>
}

export class LivingMemoryDreamCoordinator {
    private readonly queue = new SerialTaskQueue()
    private readonly pendingByPreset = new Map<string, number>()
    private readonly runningJobs = new Map<string, string>()
    private readonly controller = new AbortController()
    private readonly tasks = new Set<Promise<void>>()

    constructor(
        private readonly jobRunner: Pick<LivingMemoryDreamJobRunner, 'run'>,
        private readonly repository: DreamCoordinatorRepository,
        private readonly logger: LivingMemoryLogger
    ) {}

    start(presetId: string): Promise<DreamTriggerResult> {
        this.controller.signal.throwIfAborted()
        if (this.pendingByPreset.has(presetId)) {
            return Promise.resolve({
                success: true,
                started: false,
                reason: 'preset-locked',
                runningJobId: this.runningJobs.get(presetId)
            })
        }
        let task!: Promise<void>
        const started = new Promise<DreamTriggerResult>((resolve, reject) => {
            task = this.enqueue(presetId, async () => {
                try {
                    this.controller.signal.throwIfAborted()
                    const count =
                        await this.repository.countActiveEntries(presetId)
                    if (count < DREAM_MIN_ACTIVE_MEMORY_COUNT) {
                        resolve({
                            success: true,
                            started: false,
                            reason: 'insufficient-memories'
                        })
                        return
                    }
                    await this.runJob(presetId, { mode: 'full' }, () =>
                        resolve({ success: true, started: true })
                    )
                } catch (error) {
                    reject(error)
                    throw error
                }
            })
        })
        return started.then(
            async (result) => {
                if (!result.started) await task
                return result
            },
            async (error) => {
                await task
                throw error
            }
        )
    }

    queueIncremental(presetId: string, memoryIds: string[]) {
        if (this.controller.signal.aborted) return
        void this.enqueue(presetId, async () => {
            if (this.controller.signal.aborted) return
            await this.runJob(presetId, { mode: 'incremental', memoryIds })
        })
    }

    private enqueue(presetId: string, run: () => Promise<void>) {
        this.pendingByPreset.set(
            presetId,
            (this.pendingByPreset.get(presetId) ?? 0) + 1
        )
        const task = this.queue
            .run(presetId, run)
            .catch((error) => {
                this.logger.summary(
                    'Dream 任务执行失败',
                    `预设：${presetId}`,
                    'error',
                    error
                )
            })
            .finally(() => {
                const remaining = this.pendingByPreset.get(presetId)! - 1
                if (remaining === 0) this.pendingByPreset.delete(presetId)
                else this.pendingByPreset.set(presetId, remaining)
                this.tasks.delete(task)
            })
        this.tasks.add(task)
        return task
    }

    private async runJob(
        presetId: string,
        input: DreamRunInput,
        onStarted?: () => void
    ) {
        const signal = this.controller.signal
        signal.throwIfAborted()
        const recovered = await this.repository.markStaleRunningJobsAsFailed(
            { presetId, kind: 'dream' },
            'dream recovered: stale running job'
        )
        if (recovered.length > 0) {
            this.logger.diagnosticSummary(() => ({
                event: 'Dream 中断任务状态恢复完成',
                detail: `预设：${presetId}; 标记失败：${recovered.length} 个任务`
            }))
        }
        signal.throwIfAborted()
        const trigger = input.mode === 'full' ? 'manual' : 'incremental'
        const scope: MemoryScope = {
            conversationId: `dream:${trigger}:${presetId}`,
            presetId
        }
        const job = await this.repository.createJob(
            scope,
            'dream',
            `${trigger}:${presetId}`
        )
        this.runningJobs.set(presetId, job.id)
        onStarted?.()
        try {
            await this.jobRunner.run(scope, job.id, signal, input)
        } finally {
            this.runningJobs.delete(presetId)
        }
    }

    async stop() {
        this.controller.abort(new Error('Dream 服务正在停止。'))
        await Promise.allSettled([...this.tasks])
    }
}
