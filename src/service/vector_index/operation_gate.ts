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
    private readonly activeMutations = new Set<Promise<unknown>>()

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
}

export class VectorIndexPresetMutationQueue {
    private readonly tails = new Map<string, Promise<void>>()

    constructor(private readonly gate: VectorIndexOperationGate) {}

    run<T>(presetId: string, task: () => Promise<T>) {
        let previous = this.tails.get(presetId)
        if (previous === undefined) {
            previous = Promise.resolve()
        }
        const operation = previous.then(() => this.gate.runMutation(task))
        const settled = operation.then(
            () => undefined,
            () => undefined
        )
        this.tails.set(presetId, settled)
        settled.then(() => {
            if (this.tails.get(presetId) === settled) {
                this.tails.delete(presetId)
            }
        })
        return operation
    }

    async wait(presetId: string) {
        const tail = this.tails.get(presetId)
        if (tail !== undefined) {
            await tail
        }
    }
}
