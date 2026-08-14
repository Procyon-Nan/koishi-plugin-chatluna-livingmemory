import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toError } from '../shared/utils'
import { LivingMemoryVectorIndexError } from './errors'

const LOCK_REFRESH_INTERVAL = 10_000
const LOCK_STALE_AFTER = 60_000
const LOCK_HANDOFF_TIMEOUT = 30_000

interface VectorIndexLockRecord {
    pid: number
    token: string
}

interface VectorIndexLockHolder {
    releasing: boolean
    released: Promise<void>
    resolveReleased: () => void
}

// 同进程内的锁持有者登记。koishi 重载插件时，cordis 的 restart() 会在旧实例
// 异步 stop() 完成前同步启动新实例，新实例需等待旧实例释放锁文件后才能接管。
const lockHolders = new Map<string, VectorIndexLockHolder>()

const isFileExistsError = (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const isFileMissingError = (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
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
    private holder: VectorIndexLockHolder | null = null

    constructor(
        private readonly lockPath: string,
        private readonly onFailure: (error: Error) => void
    ) {}

    async acquire() {
        await mkdir(dirname(this.lockPath), { recursive: true })
        await this.awaitInProcessHandoff()
        await this.claimLock()
        this.registerHolder()
        this.acquired = true
        this.startRefresh()
    }

    prepareRelease() {
        if (this.holder !== null) {
            this.holder.releasing = true
        }
    }

    async release() {
        this.stopRefresh()
        try {
            if (!this.acquired) {
                return
            }

            const record = await readLockRecord(this.lockPath)
            if (record !== null && record.token === this.token) {
                await unlink(this.lockPath)
            }
        } finally {
            this.acquired = false
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
        if (holder === undefined || !holder.releasing) {
            return
        }
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LOCK_HANDOFF_TIMEOUT)
        })
        timer?.unref()
        try {
            await Promise.race([holder.released, timeout])
        } finally {
            clearTimeout(timer)
        }
    }

    private async claimLock() {
        try {
            await this.createLockFile()
            return
        } catch (error) {
            if (!isFileExistsError(error)) {
                throw error
            }
            if (!(await this.removeStaleLock())) {
                throw createLockConflictError(this.lockPath, error)
            }
        }

        try {
            await this.createLockFile()
        } catch (error) {
            if (isFileExistsError(error)) {
                throw createLockConflictError(this.lockPath, error)
            }
            throw error
        }
    }

    private startRefresh() {
        this.refreshTimer = setInterval(() => {
            const now = new Date()
            utimes(this.lockPath, now, now).catch((error) => {
                this.stopRefresh()
                this.onFailure(toError(error))
            })
        }, LOCK_REFRESH_INTERVAL)
        this.refreshTimer.unref()
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

        let record: VectorIndexLockRecord | null = null
        try {
            record = await readLockRecord(this.lockPath)
        } catch (error) {
            if (!isFileMissingError(error)) {
                throw error
            }
            return true
        }

        // 属主 pid 已死时锁必然失效，可立即接管；仅当属主存活或记录无法
        // 解析时，才依据 mtime 新鲜度判断属主是否仍在续约。
        if (
            (record !== null && isProcessAlive(record.pid)) ||
            (record === null &&
                Date.now() - lockStat.mtimeMs < LOCK_STALE_AFTER)
        ) {
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
