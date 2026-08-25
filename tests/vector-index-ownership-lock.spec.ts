import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { LivingMemoryVectorIndexError } from '../src/service/vector_index/errors'
import { LivingMemoryVectorIndexOwnershipLock } from '../src/service/vector_index/ownership_lock'

const fixturePath = resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'vector-index-lock-holder.cjs'
)

const withTemporaryDirectory = async (
    callback: (directory: string) => Promise<void>
) => {
    const directory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-lock-test-')
    )
    try {
        await callback(directory)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

const assertFileMissing = async (filePath: string) => {
    await assert.rejects(stat(filePath), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
        return true
    })
}

const waitForExit = (child: ChildProcess) => {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
            child.once('exit', (code, signal) => {
                resolveExit({ code, signal })
            })
        }
    )
}

const startLockHolder = async (lockPath: string, mode: 'exit' | 'hold') => {
    const child = fork(fixturePath, [lockPath, mode], {
        execArgv: ['-r', 'esbuild-register'],
        silent: true
    })
    const exit = waitForExit(child)
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
    })
    await new Promise<void>((resolveAcquired, rejectAcquired) => {
        const cleanup = () => {
            child.off('message', onMessage)
            child.off('error', onError)
            child.off('exit', onExit)
        }
        const onMessage = (message: unknown) => {
            if (
                message === null ||
                typeof message !== 'object' ||
                !('type' in message) ||
                message.type !== 'acquired'
            ) {
                return
            }
            cleanup()
            resolveAcquired()
        }
        const onError = (error: Error) => {
            cleanup()
            rejectAcquired(error)
        }
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            rejectAcquired(
                new Error(
                    `lock holder exited before acquiring: code=${code}, ` +
                        `signal=${signal ?? 'none'}, stderr=${stderr}`
                )
            )
        }
        child.on('message', onMessage)
        child.on('error', onError)
        child.on('exit', onExit)
    })
    return { child, exit }
}

const assertLockConflict = async (
    lock: LivingMemoryVectorIndexOwnershipLock,
    message: RegExp
) => {
    await assert.rejects(lock.acquire(), (error: unknown) => {
        assert.ok(error instanceof LivingMemoryVectorIndexError)
        assert.equal(error.code, 'lock-conflict')
        assert.match(error.message, message)
        return true
    })
}

it('removes the lockfile on release and rejects an active owner in the same process', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const lockPath = resolve(baseDir, 'vector-index.lock')
        const first = new LivingMemoryVectorIndexOwnershipLock(lockPath)
        const second = new LivingMemoryVectorIndexOwnershipLock(lockPath)

        await first.acquire()
        try {
            await assertLockConflict(second, /already held in this process/u)
        } finally {
            await first.release()
        }

        await assertFileMissing(lockPath)
        await second.acquire()
        await second.release()
    })
})

it('hands the lock to a replacement while the current owner is releasing', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const lockPath = resolve(baseDir, 'vector-index.lock')
        const first = new LivingMemoryVectorIndexOwnershipLock(lockPath)
        const second = new LivingMemoryVectorIndexOwnershipLock(lockPath)

        await first.acquire()
        first.prepareRelease()
        const takeover = second.acquire()
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
        await first.release()
        await takeover
        await second.release()
    })
})

it('serializes stale lock cleanup across replacement owners', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const lockPath = resolve(baseDir, 'vector-index.lock')
        await writeFile(
            lockPath,
            JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' })
        )

        const contenders = Array.from({ length: 8 }, () =>
            new LivingMemoryVectorIndexOwnershipLock(lockPath)
        )
        const settled = await Promise.allSettled(
            contenders.map((lock) => lock.acquire())
        )

        assert.equal(
            settled.filter((result) => result.status === 'fulfilled').length,
            1
        )
        assert.equal(
            settled.filter((result) => result.status === 'rejected').length,
            contenders.length - 1
        )

        for (const [index, result] of settled.entries()) {
            if (result.status === 'fulfilled') {
                await contenders[index].release()
            } else {
                assert.ok(result.reason instanceof LivingMemoryVectorIndexError)
                assert.equal(result.reason.code, 'lock-conflict')
            }
        }
        await assertFileMissing(lockPath)
    })
})

it('migrates only recognizable legacy lock records', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const deadOwnerPath = resolve(baseDir, 'dead-owner.lock')
        await writeFile(
            deadOwnerPath,
            JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' })
        )
        const deadOwnerLock = new LivingMemoryVectorIndexOwnershipLock(
            deadOwnerPath
        )
        await deadOwnerLock.acquire()
        await deadOwnerLock.release()
        await assertFileMissing(deadOwnerPath)

        const reusedPidPath = resolve(baseDir, 'reused-pid.lock')
        await writeFile(
            reusedPidPath,
            JSON.stringify({ pid: process.pid, token: 'reused-pid' })
        )
        await utimes(reusedPidPath, new Date(0), new Date(0))
        const reusedPidLock = new LivingMemoryVectorIndexOwnershipLock(
            reusedPidPath
        )
        await reusedPidLock.acquire()
        await reusedPidLock.release()
        await assertFileMissing(reusedPidPath)

        const invalidPath = resolve(baseDir, 'invalid.lock')
        await writeFile(invalidPath, 'not json')
        const invalidLock = new LivingMemoryVectorIndexOwnershipLock(
            invalidPath
        )
        await assertLockConflict(invalidLock, /unrecognized vector index lock/u)
    })
})

it('releases the lockfile on normal and forced process exit', async () => {
    await withTemporaryDirectory(async (baseDir) => {
        const lockPath = resolve(baseDir, 'vector-index.lock')

        const normal = await startLockHolder(lockPath, 'exit')
        assert.deepEqual(await normal.exit, { code: 0, signal: null })
        const afterNormalExit = new LivingMemoryVectorIndexOwnershipLock(
            lockPath
        )
        await afterNormalExit.acquire()
        await afterNormalExit.release()

        const forced = await startLockHolder(lockPath, 'hold')
        try {
            await assertLockConflict(
                new LivingMemoryVectorIndexOwnershipLock(lockPath),
                /held by another process/u
            )
        } finally {
            forced.child.kill()
        }
        const forcedExit = await forced.exit
        assert.notEqual(forcedExit.signal, null)

        const afterForcedExit = new LivingMemoryVectorIndexOwnershipLock(
            lockPath
        )
        await afterForcedExit.acquire()
        await afterForcedExit.release()
    })
})
