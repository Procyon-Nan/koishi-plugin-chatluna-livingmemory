export class PresetTaskQueue {
    private readonly tails = new Map<string, Promise<void>>()

    run<T>(presetId: string, task: () => Promise<T>) {
        const previous = this.tails.get(presetId) ?? Promise.resolve()
        const operation = previous.then(task)
        const settled = operation.then(
            () => undefined,
            () => undefined
        )
        this.tails.set(presetId, settled)
        void settled.then(() => {
            if (this.tails.get(presetId) === settled) {
                this.tails.delete(presetId)
            }
        })
        return operation
    }

    wait(presetId: string) {
        return this.tails.get(presetId) ?? Promise.resolve()
    }
}
