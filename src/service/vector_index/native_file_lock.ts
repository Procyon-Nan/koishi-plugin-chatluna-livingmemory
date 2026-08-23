import type { FileHandle } from 'node:fs/promises'
import { open } from 'node:fs/promises'

interface NativeLockOperations {
    tryLock(fd: number): boolean
    unlock(fd: number): void
}

let operations: Promise<NativeLockOperations> | null = null

const loadOperations = async () => {
    operations ??= import('fs-native-extensions').then((module) => ({
        tryLock: module.tryLock,
        unlock: module.unlock
    }))
    return operations
}

export class LivingMemoryNativeFileLock {
    private constructor(
        private readonly handle: FileHandle,
        private readonly operations: NativeLockOperations
    ) {}

    static async tryAcquire(lockPath: string) {
        const operations = await loadOperations()
        const handle = await open(lockPath, 'a+')
        let acquired = false
        try {
            acquired = operations.tryLock(handle.fd)
            if (!acquired) {
                return null
            }
            return new LivingMemoryNativeFileLock(handle, operations)
        } finally {
            if (!acquired) {
                await handle.close()
            }
        }
    }

    async inspectAnchor() {
        const [content, fileStat] = await Promise.all([
            this.handle.readFile('utf8'),
            this.handle.stat()
        ])
        return { content, mtimeMs: fileStat.mtimeMs }
    }

    async release() {
        try {
            this.operations.unlock(this.handle.fd)
        } finally {
            await this.handle.close()
        }
    }
}
