import { randomUUID } from 'node:crypto'
import {
    link,
    mkdir,
    readFile,
    stat,
    unlink,
    writeFile
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { LivingMemoryVectorIndexError } from './errors'

const LOCK_HANDOFF_TIMEOUT = 30_000
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1_000
const LOCK_CLEANUP_POLL_INTERVAL = 50
const LOCK_HOLDERS_KEY = Symbol.for(
    'chatluna-livingmemory.vector-index-lock-holders'
)

interface VectorIndexLockRecord {
    pid: number
    token: string
}

interface VectorIndexLockHolder {
    releasing: boolean
    released: Promise<void>
    resolveReleased: () => void
}

interface LockInspection {
    content: string
    mtimeMs: number
    record: VectorIndexLockRecord | null
}

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

const parseLockRecord = (content: string) => {
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
    const record = parsed as Partial<VectorIndexLockRecord>
    if (
        typeof record.pid !== 'number' ||
        !Number.isInteger(record.pid) ||
        record.pid < 1 ||
        typeof record.token !== 'string' ||
        record.token.length === 0
    ) {
        return null
    }
    return record as VectorIndexLockRecord
}

const isStaleLockRecord = (record: VectorIndexLockRecord, mtimeMs: number) => {
    if (record.pid === process.pid) {
        return mtimeMs < PROCESS_STARTED_AT
    }
    return !isProcessAlive(record.pid)
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
    private readonly cleanupLockPath: string
    private fileLockToken: string | null = null
    private holder: VectorIndexLockHolder | null = null

    constructor(private readonly lockPath: string) {
        this.cleanupLockPath = `${lockPath}.cleanup`
    }

    async acquire() {
        await mkdir(dirname(this.lockPath), { recursive: true })

        while (true) {
            await this.awaitInProcessHandoff()
            const token = await this.tryAcquireFileLock()
            if (token !== null) {
                this.fileLockToken = token
                this.registerHolder()
                return
            }

            await this.removeStaleLock()
        }
    }

    prepareRelease() {
        if (this.holder !== null) {
            this.holder.releasing = true
        }
    }

    async release() {
        const token = this.fileLockToken
        this.fileLockToken = null
        try {
            if (token !== null) {
                await this.releaseFileLock(token)
            }
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

    private async tryAcquireFileLock(): Promise<string | null> {
        return this.tryAcquireLockFile(this.lockPath)
    }

    private async tryAcquireLockFile(lockPath: string): Promise<string | null> {
        const token = randomUUID()
        const temporaryPath = `${lockPath}.${process.pid}.${token}.tmp`
        await writeFile(
            temporaryPath,
            JSON.stringify({ pid: process.pid, token }),
            { flag: 'wx' }
        )
        try {
            await link(temporaryPath, lockPath)
        } catch (error) {
            if (
                error instanceof Error &&
                'code' in error &&
                error.code === 'EEXIST'
            ) {
                return null
            }
            throw error
        } finally {
            await unlink(temporaryPath).catch(() => undefined)
        }
        return token
    }

    private async inspectExistingLockDisposition(): Promise<void> {
        const inspection = await this.inspectExistingLock()
        if (inspection === null || inspection.content.trim().length === 0) {
            return
        }
        if (inspection.record === null) {
            throw createLockConflictError(
                this.lockPath,
                'unrecognized vector index lock'
            )
        }

        const { pid } = inspection.record
        if (isStaleLockRecord(inspection.record, inspection.mtimeMs)) {
            return
        }
        if (pid === process.pid) {
            throw createLockConflictError(
                this.lockPath,
                'vector index lock is already held in this process'
            )
        }
        throw createLockConflictError(
            this.lockPath,
            'vector index lock is held by another process'
        )
    }

    private async inspectExistingLock(): Promise<LockInspection | null> {
        try {
            const [content, fileStat] = await Promise.all([
                readFile(this.lockPath, 'utf8'),
                stat(this.lockPath)
            ])
            return {
                content,
                mtimeMs: fileStat.mtimeMs,
                record: parseLockRecord(content)
            }
        } catch (error) {
            if (isFileMissingError(error)) {
                return null
            }
            throw error
        }
    }

    private async removeStaleLock() {
        const cleanupToken = await this.acquireCleanupLock()
        try {
            await this.inspectExistingLockDisposition()
            try {
                await unlink(this.lockPath)
            } catch (error) {
                if (isFileMissingError(error)) {
                    return
                }
                throw new LivingMemoryVectorIndexError(
                    'lock-unavailable',
                    'unavailable',
                    `stale vector index lock cleanup failed: ${this.lockPath}`,
                    { cause: error }
                )
            }
        } finally {
            await this.releaseCleanupLock(cleanupToken)
        }
    }

    private async acquireCleanupLock() {
        const deadline = Date.now() + LOCK_HANDOFF_TIMEOUT
        while (Date.now() < deadline) {
            const token = await this.tryAcquireLockFile(this.cleanupLockPath)
            if (token !== null) {
                return token
            }

            await this.removeStaleCleanupLock()
            await delay(LOCK_CLEANUP_POLL_INTERVAL)
        }
        throw createLockConflictError(
            this.lockPath,
            `stale vector index lock cleanup did not finish within ` +
                `${LOCK_HANDOFF_TIMEOUT}ms`
        )
    }

    private async releaseCleanupLock(token: string) {
        try {
            const inspection = await this.inspectCleanupLock()
            if (
                inspection?.record?.pid !== process.pid ||
                inspection.record.token !== token
            ) {
                return
            }
            await unlink(this.cleanupLockPath)
        } catch (error) {
            if (!isFileMissingError(error)) {
                throw error
            }
        }
    }

    private async removeStaleCleanupLock() {
        const inspection = await this.inspectCleanupLock()
        if (inspection === null) {
            return
        }
        if (inspection.record === null) {
            throw createLockConflictError(
                this.lockPath,
                'unrecognized vector index cleanup lock'
            )
        }
        if (!isStaleLockRecord(inspection.record, inspection.mtimeMs)) {
            return
        }
        await unlink(this.cleanupLockPath).catch((error: unknown) => {
            if (!isFileMissingError(error)) {
                throw error
            }
        })
    }

    private async inspectCleanupLock() {
        try {
            const [content, fileStat] = await Promise.all([
                readFile(this.cleanupLockPath, 'utf8'),
                stat(this.cleanupLockPath)
            ])
            return {
                content,
                mtimeMs: fileStat.mtimeMs,
                record: parseLockRecord(content)
            }
        } catch (error) {
            if (isFileMissingError(error)) {
                return null
            }
            throw error
        }
    }

    private async releaseFileLock(token: string) {
        const inspection = await this.inspectExistingLock()
        if (
            inspection?.record?.pid !== process.pid ||
            inspection.record.token !== token
        ) {
            return
        }
        try {
            await unlink(this.lockPath)
        } catch (error) {
            if (!isFileMissingError(error)) {
                throw error
            }
        }
    }
}
