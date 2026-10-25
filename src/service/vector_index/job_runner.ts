import type { MemoryJobRecord } from '../../contracts/memory'
import type { JobRepository } from '../../contracts/workflows'
import { LivingMemoryJobTracker } from '../workflows/job_tracker'
import type { LivingMemoryLogger } from '../logging/logger'

const INDEX_JOB_CONVERSATION = 'vector-index'

export type VectorIndexJobRepository = Pick<
    JobRepository,
    'createJob' | 'updateJob'
>

export class LivingMemoryVectorIndexJobRunner {
    private readonly tracker: LivingMemoryJobTracker

    constructor(
        private readonly repository: VectorIndexJobRepository,
        private readonly onCurrentJobChanged: (jobId: string | null) => void,
        private readonly logger: LivingMemoryLogger
    ) {
        this.tracker = new LivingMemoryJobTracker(repository)
    }

    async run(
        presetId: string,
        input: string,
        operation: (job: MemoryJobRecord) => Promise<string>
    ) {
        const job = await this.create(presetId, input)
        await this.runCreated(job, input, operation)
    }

    create(presetId: string, input: string) {
        return this.repository.createJob(
            {
                presetId,
                conversationId: INDEX_JOB_CONVERSATION
            },
            'index',
            input
        )
    }

    async runCreated(
        job: MemoryJobRecord,
        input: string,
        operation: (job: MemoryJobRecord) => Promise<string>
    ) {
        this.onCurrentJobChanged(job.id)
        const operationName = input.split(':', 1)[0]
        const logger = this.logger.with({
            workflow: 'vector-index',
            jobId: job.id,
            presetId: job.presetId
        })
        let running = false
        try {
            await this.tracker.markRunning(job.id)
            running = true
            logger.info(`vector-index.${operationName}.started`)
            const detail = await operation(job)
            await this.tracker.markCompleted(job.id, detail)
            logger.info(`vector-index.${operationName}.completed`, { detail })
        } catch (error) {
            logger.warn(`vector-index.${operationName}.failed`, {}, error)
            if (running) {
                await this.tracker.markFailed(
                    job.id,
                    error,
                    `vector index job failed: ${input}`
                )
            }
            throw error
        } finally {
            this.onCurrentJobChanged(null)
        }
    }
}
