import { randomUUID } from 'crypto'
import { Context } from 'koishi'
import type {
    MemoryJobKind,
    MemoryJobRecord,
    MemoryRecallStrategy,
    MemoryScope
} from '../../contracts/memory'
import type { JobRepository } from '../../contracts/workflows'
import { summarizeError } from '../shared/utils'

export class LivingMemoryJobRepository implements JobRepository {
    constructor(private readonly ctx: Context) {}

    async createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        recallStrategy: MemoryRecallStrategy | null = null
    ): Promise<MemoryJobRecord> {
        const now = new Date()
        const job: MemoryJobRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            recallStrategy,
            status: 'pending',
            input,
            detail: null,
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        }

        await this.ctx.database.create('living_memory_job', job)
        return job
    }

    async createFailedJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string,
        error: unknown,
        startedAt: Date,
        recallStrategy: MemoryRecallStrategy | null = null
    ): Promise<MemoryJobRecord> {
        const finishedAt = new Date()
        const job: MemoryJobRecord = {
            id: randomUUID(),
            presetId: scope.presetId,
            conversationId: scope.conversationId,
            kind,
            recallStrategy,
            status: 'failed',
            input,
            detail: null,
            error: summarizeError(error),
            createdAt: startedAt,
            startedAt,
            finishedAt,
            updatedAt: finishedAt
        }

        await this.ctx.database.create('living_memory_job', job)
        return job
    }

    async updateJob(
        id: string,
        patch: Partial<MemoryJobRecord>
    ): Promise<void> {
        await this.ctx.database.set('living_memory_job', { id }, patch)
    }

    async listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]> {
        const jobs = await this.ctx.database.get('living_memory_job', {
            presetId
        })

        return jobs.sort((left, right) => +right.createdAt - +left.createdAt)
    }

    async getLatestJobByPresetAndKind(
        presetId: string,
        kind: MemoryJobKind
    ): Promise<MemoryJobRecord | undefined> {
        const jobs = await this.ctx.database.get('living_memory_job', {
            presetId,
            kind
        })

        return jobs.sort((left, right) => +right.createdAt - +left.createdAt)[0]
    }

    async markStaleRunningJobsAsFailed(
        options: { presetId?: string; kind?: MemoryJobKind } = {},
        reason = 'recovered: stale running job'
    ): Promise<MemoryJobRecord[]> {
        // 同时回收 pending 与 running：作业表为审计日志，不参与调度。
        // 若进程在 createJob（写入 pending）之后、markRunning 之前被终止，
        // 该行会永久卡在 pending，仅扫 running 无法清理，遗留幽灵审计记录。
        const query: Record<string, unknown> = {
            status: { $in: ['pending', 'running'] }
        }
        if (options.presetId != null) {
            query.presetId = options.presetId
        }
        if (options.kind != null) {
            query.kind = options.kind
        }

        const stale = await this.ctx.database.get('living_memory_job', query)
        if (stale.length === 0) {
            return []
        }

        const now = new Date()
        await this.ctx.database.set(
            'living_memory_job',
            { id: { $in: stale.map((job) => job.id) } },
            {
                status: 'failed',
                detail: reason,
                error: reason,
                finishedAt: now,
                updatedAt: now
            }
        )

        return stale
    }

    async removeExpiredJobs(deadline: Date) {
        await this.ctx.database.remove('living_memory_job', {
            updatedAt: {
                $lt: deadline
            }
        })
    }
}
