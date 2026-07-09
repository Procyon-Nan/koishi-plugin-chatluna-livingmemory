import { LivingMemoryRepository } from '../persistence/repository'
import { summarizeError } from '../shared/utils'

export class LivingMemoryJobTracker {
    constructor(private readonly repository: LivingMemoryRepository) {}

    async markRunning(id: string) {
        await this.repository.updateJob(id, {
            status: 'running',
            startedAt: new Date(),
            updatedAt: new Date()
        })
    }

    async markCompleted(id: string, detail: string) {
        await this.repository.updateJob(id, {
            status: 'completed',
            finishedAt: new Date(),
            updatedAt: new Date(),
            detail
        })
    }

    async markFailed(id: string, error: unknown) {
        await this.repository.updateJob(id, {
            status: 'failed',
            finishedAt: new Date(),
            updatedAt: new Date(),
            error: summarizeError(error)
        })
    }
}
