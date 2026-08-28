import { PresetTaskQueue } from '../shared/preset_task_queue'

const createDeferred = () => {
    let resolvePromise = () => {}
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve
    })
    return { promise, resolve: resolvePromise }
}

export class VectorIndexOperationGate {
    private mutationBarrier = Promise.resolve()
    private exclusiveTail = Promise.resolve()
    private accepting = true
    private readonly activeOperations = new Set<Promise<unknown>>()
    private readonly activeMutations = new Set<Promise<unknown>>()

    get stopping() {
        return !this.accepting
    }

    run<T>(task: () => Promise<T>) {
        this.assertAccepting()
        return this.track(task())
    }

    runMutation<T>(task: () => Promise<T>) {
        const barrier = this.mutationBarrier
        const operation = (async () => {
            await barrier
            return await task()
        })()
        this.activeMutations.add(operation)
        operation.then(
            () => this.activeMutations.delete(operation),
            () => this.activeMutations.delete(operation)
        )
        return operation
    }

    async runExclusive<T>(task: () => Promise<T>) {
        this.assertAccepting()
        return this.track(this.runExclusiveTask(task))
    }

    beginStop() {
        this.accepting = false
    }

    async drain() {
        await Promise.allSettled([...this.activeOperations])
    }

    reset() {
        this.accepting = true
    }

    assertAccepting() {
        if (!this.accepting) {
            throw new Error('vector index service is stopping')
        }
    }

    private async runExclusiveTask<T>(task: () => Promise<T>) {
        const previousBarrier = this.mutationBarrier
        const pendingMutations = [...this.activeMutations]
        const barrier = createDeferred()
        this.mutationBarrier = previousBarrier.then(() => barrier.promise)

        const previousExclusive = this.exclusiveTail
        const exclusive = createDeferred()
        this.exclusiveTail = exclusive.promise

        try {
            await previousExclusive
            await previousBarrier
            await Promise.all(pendingMutations)
            return await task()
        } finally {
            barrier.resolve()
            exclusive.resolve()
        }
    }

    private track<T>(operation: Promise<T>) {
        this.activeOperations.add(operation)
        operation.then(
            () => this.activeOperations.delete(operation),
            () => this.activeOperations.delete(operation)
        )
        return operation
    }
}

export class VectorIndexPresetMutationQueue {
    private readonly queue = new PresetTaskQueue()

    constructor(private readonly gate: VectorIndexOperationGate) {}

    run<T>(presetId: string, task: () => Promise<T>) {
        return this.queue.run(presetId, () => this.gate.runMutation(task))
    }

    async wait(presetId: string) {
        await this.queue.wait(presetId)
    }
}
