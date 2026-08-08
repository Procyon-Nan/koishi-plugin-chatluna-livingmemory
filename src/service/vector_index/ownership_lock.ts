import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LivingMemoryVectorIndexError } from './errors'

const LOCK_REFRESH_INTERVAL = 10_000
const LOCK_STALE_AFTER = 60_000

interface VectorIndexLockRecord {
    pid: number
    token: string
}

const isFileExistsError = (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const isFileMissingError = (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const toError = (error: unknown) => {
    if (error instanceof Error) {
        return error
    }
    return new Error(String(error))
}

const createLockConflictError = (lockPath: string, cause: unknown) => {
    return new LivingMemoryVectorIndexError(
        'lock-conflict',
        'unavailable',
        `vector index lock is held by another process: ${lockPath}`,
        { cause }
    )
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

const readLockRecord = async (lockPath: string) => {
    const content = await readFile(lockPath, 'utf8')
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

export class LivingMemoryVectorIndexOwnershipLock {
    private readonly token = randomUUID()
    private refreshTimer: NodeJS.Timeout | null = null
    private acquired = false

    constructor(
        private readonly lockPath: string,
        private readonly onFailure: (error: Error) => void
    ) {}

    async acquire() {
        await mkdir(dirname(this.lockPath), { recursive: true })
        try {
            await this.createLockFile()
        } catch (error) {
            if (!isFileExistsError(error)) {
                throw error
            }
            if (!(await this.removeStaleLock())) {
                throw createLockConflictError(this.lockPath, error)
            }
            try {
                await this.createLockFile()
            } catch (retryError) {
                if (isFileExistsError(retryError)) {
                    throw createLockConflictError(this.lockPath, retryError)
                }
                throw retryError
            }
        }

        this.acquired = true
        this.refreshTimer = setInterval(() => {
            const now = new Date()
            utimes(this.lockPath, now, now).catch((error) => {
                this.stopRefresh()
                this.onFailure(toError(error))
            })
        }, LOCK_REFRESH_INTERVAL)
        this.refreshTimer.unref()
    }

    async release() {
        this.stopRefresh()
        if (!this.acquired) {
            return
        }

        const record = await readLockRecord(this.lockPath)
        if (record !== null && record.token === this.token) {
            await unlink(this.lockPath)
        }
        this.acquired = false
    }

    private async createLockFile() {
        const handle = await open(this.lockPath, 'wx')
        try {
            await handle.writeFile(
                JSON.stringify({ pid: process.pid, token: this.token })
            )
        } finally {
            await handle.close()
        }
    }

    private stopRefresh() {
        if (this.refreshTimer !== null) {
            clearInterval(this.refreshTimer)
            this.refreshTimer = null
        }
    }

    private async removeStaleLock() {
        let lockStat: Stats
        try {
            lockStat = await stat(this.lockPath)
        } catch (error) {
            if (isFileMissingError(error)) {
                return true
            }
            throw error
        }
        if (Date.now() - lockStat.mtimeMs < LOCK_STALE_AFTER) {
            return false
        }

        let record: VectorIndexLockRecord | null = null
        try {
            record = await readLockRecord(this.lockPath)
        } catch (error) {
            if (!isFileMissingError(error)) {
                throw error
            }
            return true
        }
        if (record !== null && isProcessAlive(record.pid)) {
            return false
        }

        try {
            await unlink(this.lockPath)
        } catch (error) {
            if (!isFileMissingError(error)) {
                throw error
            }
        }
        return true
    }
}
