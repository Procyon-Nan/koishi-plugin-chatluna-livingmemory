export class SerialTaskQueue {
    private readonly tails = new Map<string, Promise<void>>()

    run<T>(key: string, task: () => Promise<T>) {
        const previous = this.tails.get(key) ?? Promise.resolve()
        const operation = previous.then(task)
        const settled = operation.then(
            () => undefined,
            () => undefined
        )
        this.tails.set(key, settled)
        void settled.then(() => {
            if (this.tails.get(key) === settled) {
                this.tails.delete(key)
            }
        })
        return operation
    }

    wait(key: string) {
        return this.tails.get(key) ?? Promise.resolve()
    }
}
