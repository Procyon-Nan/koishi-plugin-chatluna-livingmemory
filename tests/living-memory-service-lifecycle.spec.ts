import assert from 'node:assert/strict'
import { ChatLunaLivingMemoryService } from '../src/service/app/living_memory_service'

interface ServiceLifecycle {
    start(): Promise<void>
    stop(): Promise<void>
}

const createService = (options: {
    vectorStart: () => Promise<void>
    vectorStop: () => Promise<void>
    dreamStart: () => Promise<void>
    dreamStop: () => Promise<void>
}) => {
    const service = Object.create(
        ChatLunaLivingMemoryService.prototype
    ) as ServiceLifecycle
    Object.defineProperties(service, {
        repository: {
            value: {
                migrateMemorySourceOriginsArray: async () => 0,
                migrateActiveMemorySpeakers: async () => 0,
                dropLegacyPendingIndexes: async () => [],
                markStaleRunningJobsAsFailed: async () => []
            }
        },
        validateConfig: {
            value: () => []
        },
        archivedMemoryCleanup: {
            value: Promise.resolve(),
            writable: true
        },
        queueExpiredArchivedMemoryCleanup: {
            value: () => {}
        },
        vectorIndex: {
            value: {
                start: options.vectorStart,
                stop: options.vectorStop,
                beginStop: () => {}
            }
        },
        dreamWorker: {
            value: { start: options.dreamStart, stop: options.dreamStop }
        }
    })
    return service
}

it('starts and stops the Dream worker in service lifecycle order', async () => {
    const events: string[] = []
    const service = createService({
        vectorStart: async () => {
            events.push('vector-start')
        },
        vectorStop: async () => {
            events.push('vector-stop')
        },
        dreamStart: async () => {
            events.push('dream-start')
        },
        dreamStop: async () => {
            events.push('dream-stop')
        }
    })

    await service.start()
    await service.stop()

    assert.deepEqual(events, [
        'vector-start',
        'dream-start',
        'dream-stop',
        'vector-stop'
    ])
})

it('releases both workers when Dream worker startup fails', async () => {
    const events: string[] = []
    const service = createService({
        vectorStart: async () => {
            events.push('vector-start')
        },
        vectorStop: async () => {
            events.push('vector-stop')
        },
        dreamStart: async () => {
            events.push('dream-start')
            throw new Error('Dream worker unavailable')
        },
        dreamStop: async () => {
            events.push('dream-stop')
        }
    })

    await assert.rejects(service.start(), /Dream worker unavailable/u)
    assert.deepEqual(events, [
        'vector-start',
        'dream-start',
        'dream-stop',
        'vector-stop'
    ])
})

it('stops the vector index when Dream worker termination fails', async () => {
    const events: string[] = []
    const service = createService({
        vectorStart: async () => {},
        vectorStop: async () => {
            events.push('vector-stop')
        },
        dreamStart: async () => {},
        dreamStop: async () => {
            events.push('dream-stop')
            throw new Error('Dream worker termination failed')
        }
    })

    await assert.rejects(service.stop(), /Dream worker termination failed/u)
    assert.deepEqual(events, ['dream-stop', 'vector-stop'])
})
