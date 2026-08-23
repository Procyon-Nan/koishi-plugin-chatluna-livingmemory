import { mkdir, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LivingMemoryVectorIndexError } from './errors'
import { LivingMemoryNativeFileLock } from './native_file_lock'

const LOCK_HANDOFF_TIMEOUT = 30_000
const LEGACY_HANDOFF_POLL_INTERVAL = 50
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1_000
const LOCK_HOLDERS_KEY = Symbol.for(
    'chatluna-livingmemory.vector-index-lock-holders'
)

interface LegacyVectorIndexLockRecord {
    pid: number
    token: string
}

interface VectorIndexLockHolder {
    releasing: boolean
    released: Promise<void>
    resolveReleased: () => void
}

interface LegacyLockInspection {
    record: LegacyVectorIndexLockRecord | null
    mtimeMs: number
}

type LegacyLockDisposition = 'ready' | 'migrate' | 'wait-for-same-process'

const globalState = globalThis as unknown as Record<PropertyKey, unknown>
if (!(globalState[LOCK_HOLDERS_KEY] instanceof Map)) {
    globalState[LOCK_HOLDERS_KEY] = new Map<string, VectorIndexLockHolder>()
}
const lockHolders = globalState[LOCK_HOLDERS_KEY] as Map<
    string,
    VectorIndexLockHolder
>

const isFileMissingError = (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isProcessAlive = (pid: number) => {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'EPERM'
        ) {
            return true
        }
        return false
    }
}

const parseLegacyLockRecord = (content: string) => {
    if (content.trim().length === 0) {
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(content)
    } catch {
        return null
    }
    if (parsed === null || typeof parsed !== 'object') {
        return null
    }
    const record = parsed as Partial<LegacyVectorIndexLockRecord>
    if (
        typeof record.pid !== 'number' ||
        !Number.isInteger(record.pid) ||
        record.pid < 1 ||
        typeof record.token !== 'string' ||
        record.token.length === 0
    ) {
        return null
    }
    return record as LegacyVectorIndexLockRecord
}

const createLockConflictError = (
    lockPath: string,
    detail: string,
    cause?: unknown
) => {
    return new LivingMemoryVectorIndexError(
        'lock-conflict',
        'unavailable',
        `${detail}: ${lockPath}`,
        cause === undefined ? undefined : { cause }
    )
}

const delay = (duration: number) => {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, duration)
    })
}

export class LivingMemoryVectorIndexOwnershipLock {
    private nativeLock: LivingMemoryNativeFileLock | null = null
    private holder: VectorIndexLockHolder | null = null

    constructor(private readonly lockPath: string) {}

    async acquire() {
        await mkdir(dirname(this.lockPath), { recursive: true })
        await this.awaitInProcessHandoff()

        while (true) {
            let nativeLock = await this.acquireNativeLock()
            let disposition: LegacyLockDisposition
            try {
                disposition =
                    await this.inspectLegacyLockDisposition(nativeLock)
            } catch (error) {
                await nativeLock.release()
                throw error
            }
            if (disposition === 'wait-for-same-process') {
                await nativeLock.release()
                await this.awaitLegacySameProcessHandoff()
                continue
            }
            if (disposition === 'migrate') {
                await nativeLock.release()
                try {
                    await truncate(this.lockPath, 0)
                } catch (error) {
                    throw new LivingMemoryVectorIndexError(
                        'lock-unavailable',
                        'unavailable',
                        `vector index lock migration failed: ${this.lockPath}`,
                        { cause: error }
                    )
                }
                nativeLock = await this.acquireNativeLock()
            }
            this.nativeLock = nativeLock
            this.registerHolder()
            return
        }
    }

    prepareRelease() {
        if (this.holder !== null) {
            this.holder.releasing = true
        }
    }

    async release() {
        const nativeLock = this.nativeLock
        this.nativeLock = null
        try {
            await nativeLock?.release()
        } finally {
            this.releaseHolder()
        }
    }

    private registerHolder() {
        let resolveReleased!: () => void
        const released = new Promise<void>((resolve) => {
            resolveReleased = resolve
        })
        this.holder = { releasing: false, released, resolveReleased }
        lockHolders.set(this.lockPath, this.holder)
    }

    private releaseHolder() {
        const holder = this.holder
        if (holder === null) {
            return
        }
        this.holder = null
        if (lockHolders.get(this.lockPath) === holder) {
            lockHolders.delete(this.lockPath)
        }
        holder.resolveReleased()
    }

    private async awaitInProcessHandoff() {
        const holder = lockHolders.get(this.lockPath)
        if (holder === undefined) {
            return
        }
        if (!holder.releasing) {
            throw createLockConflictError(
                this.lockPath,
                'vector index lock is already held in this process'
            )
        }

        let timer: NodeJS.Timeout | undefined
        const timedOut = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(
                    createLockConflictError(
                        this.lockPath,
                        `previous owner in this process did not release the ` +
                            `vector index lock within ${LOCK_HANDOFF_TIMEOUT}ms`
                    )
                )
            }, LOCK_HANDOFF_TIMEOUT)
        })
        try {
            await Promise.race([holder.released, timedOut])
        } finally {
            clearTimeout(timer)
        }
    }

    private async acquireNativeLock() {
        let nativeLock: LivingMemoryNativeFileLock | null
        try {
            nativeLock = await LivingMemoryNativeFileLock.tryAcquire(
                this.lockPath
            )
        } catch (error) {
            throw new LivingMemoryVectorIndexError(
                'lock-unavailable',
                'unavailable',
                `native vector index lock is unavailable: ${this.lockPath}`,
                { cause: error }
            )
        }
        if (nativeLock === null) {
            throw createLockConflictError(
                this.lockPath,
                'vector index lock is held by another process'
            )
        }
        return nativeLock
    }

    private async inspectLegacyLockDisposition(
        nativeLock: LivingMemoryNativeFileLock
    ): Promise<LegacyLockDisposition> {
        const inspection = await this.inspectLegacyLock(nativeLock)
        if (inspection === null) {
            return 'ready'
        }
        if (inspection.record === null) {
            throw createLockConflictError(
                this.lockPath,
                'unrecognized legacy vector index lock'
            )
        }

        const { pid } = inspection.record
        if (pid === process.pid) {
            if (inspection.mtimeMs < PROCESS_STARTED_AT) {
                return 'migrate'
            }
            return 'wait-for-same-process'
        }
        if (isProcessAlive(pid)) {
            throw createLockConflictError(
                this.lockPath,
                `legacy vector index lock is held by process ${pid}`
            )
        }
        return 'migrate'
    }

    private async inspectLegacyLock(
        nativeLock: LivingMemoryNativeFileLock
    ): Promise<LegacyLockInspection | null> {
        try {
            const anchor = await nativeLock.inspectAnchor()
            const { content, mtimeMs } = anchor
            if (content.trim().length === 0) {
                return null
            }
            return {
                record: parseLegacyLockRecord(content),
                mtimeMs
            }
        } catch (error) {
            if (isFileMissingError(error)) {
                return null
            }
            throw error
        }
    }

    private async awaitLegacySameProcessHandoff() {
        const deadline = Date.now() + LOCK_HANDOFF_TIMEOUT
        while (Date.now() < deadline) {
            await delay(LEGACY_HANDOFF_POLL_INTERVAL)
            try {
                await stat(this.lockPath)
            } catch (error) {
                if (isFileMissingError(error)) {
                    return
                }
                throw error
            }
        }
        throw createLockConflictError(
            this.lockPath,
            `legacy owner in this process did not release the vector index ` +
                `lock within ${LOCK_HANDOFF_TIMEOUT}ms`
        )
    }
}
