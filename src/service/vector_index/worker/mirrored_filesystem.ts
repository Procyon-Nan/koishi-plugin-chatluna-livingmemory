import {
    existsSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync
} from 'node:fs'
import {
    mkdir,
    open as openFile,
    rename,
    rm,
    writeFile
} from 'node:fs/promises'
import { dirname, join as joinPath, posix, resolve } from 'node:path'
import { MemoryFS, PGlite } from '@electric-sql/pglite'

type VirtualFileSystem = PGlite['Module']['FS']

const POSTMASTER_PID = 'postmaster.pid'

// 每次业务写入完成后将数据回写到原目录，但不复制 PostgreSQL 运行期的锁文件
export class MirroredPGliteFilesystem extends MemoryFS {
    private checkpointRequested = false
    private writebackTail: Promise<void> = Promise.resolve()

    constructor(private readonly persistentDirectory: string) {
        super()
    }

    override async initialSyncFs(): Promise<void> {
        const fs = this.pg?.Module.FS
        if (fs === undefined) {
            throw new Error('PGlite memory filesystem is not initialized')
        }
        fs.mkdirTree(PGlite.paths.PGDATA)
        this.loadPersistentFiles(fs)
    }

    async checkpoint() {
        this.checkpointRequested = true
        await this.syncToFs()
    }

    override async syncToFs(_relaxedDurability?: boolean): Promise<void> {
        if (!this.checkpointRequested) {
            return
        }
        this.checkpointRequested = false
        const writeback = this.writebackTail
            .catch(() => {})
            .then(() => this.writeSnapshot())
        this.writebackTail = writeback
        await writeback
    }

    private loadPersistentFiles(fs: VirtualFileSystem) {
        this.recoverInterruptedWriteback()
        if (!existsSync(this.persistentDirectory)) {
            return
        }
        this.copyFromDisk(fs, this.persistentDirectory, PGlite.paths.PGDATA)
    }

    private copyFromDisk(
        fs: VirtualFileSystem,
        sourceDirectory: string,
        targetDirectory: string
    ) {
        for (const name of readdirSync(sourceDirectory)) {
            if (name === POSTMASTER_PID) {
                continue
            }
            const source = joinPath(sourceDirectory, name)
            const target = posix.join(targetDirectory, name)
            const stats = statSync(source)
            if (stats.isDirectory()) {
                fs.mkdirTree(target)
                this.copyFromDisk(fs, source, target)
                continue
            }
            if (stats.isFile()) {
                fs.writeFile(target, readFileSync(source))
            }
        }
    }

    private async writeSnapshot() {
        const fs = this.pg?.Module.FS
        if (fs === undefined) {
            return
        }
        const writingDirectory = `${this.persistentDirectory}.sync-writing`
        const snapshotDirectory = `${this.persistentDirectory}.sync`
        const previousDirectory = `${this.persistentDirectory}.sync-previous`
        const parentDirectory = dirname(this.persistentDirectory)
        await rm(writingDirectory, { recursive: true, force: true })
        await rm(snapshotDirectory, { recursive: true, force: true })
        try {
            await mkdir(writingDirectory, { recursive: true })
            await this.copyToDisk(fs, PGlite.paths.PGDATA, writingDirectory)
            await this.syncDirectory(writingDirectory)
            await rename(writingDirectory, snapshotDirectory)
            await this.syncDirectory(parentDirectory)
            await rm(previousDirectory, { recursive: true, force: true })
            if (existsSync(this.persistentDirectory)) {
                await rename(this.persistentDirectory, previousDirectory)
                await this.syncDirectory(parentDirectory)
            }
            try {
                await rename(snapshotDirectory, this.persistentDirectory)
                await this.syncDirectory(parentDirectory)
            } catch (error) {
                if (
                    !existsSync(this.persistentDirectory) &&
                    existsSync(previousDirectory)
                ) {
                    await rename(previousDirectory, this.persistentDirectory)
                    await this.syncDirectory(parentDirectory)
                }
                throw error
            }
            await rm(previousDirectory, { recursive: true, force: true })
            await this.syncDirectory(parentDirectory)
        } catch (error) {
            await rm(writingDirectory, { recursive: true, force: true })
            if (existsSync(this.persistentDirectory)) {
                await rm(snapshotDirectory, { recursive: true, force: true })
            }
            throw error
        }
    }

    private async syncDirectory(directory: string) {
        // Windows 无法通过 Node.js 打开目录句柄；仍会等待文件写入和目录重命名完成。
        if (process.platform === 'win32') {
            return
        }
        const handle = await openFile(directory, 'r')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    }

    private recoverInterruptedWriteback() {
        const writingDirectory = `${this.persistentDirectory}.sync-writing`
        const snapshotDirectory = `${this.persistentDirectory}.sync`
        const previousDirectory = `${this.persistentDirectory}.sync-previous`
        rmSync(writingDirectory, { recursive: true, force: true })
        if (existsSync(this.persistentDirectory)) {
            rmSync(snapshotDirectory, { recursive: true, force: true })
            rmSync(previousDirectory, { recursive: true, force: true })
            return
        }
        if (existsSync(snapshotDirectory)) {
            renameSync(snapshotDirectory, this.persistentDirectory)
            rmSync(previousDirectory, { recursive: true, force: true })
            return
        }
        if (existsSync(previousDirectory)) {
            renameSync(previousDirectory, this.persistentDirectory)
        }
    }

    private async copyToDisk(
        fs: VirtualFileSystem,
        sourceDirectory: string,
        targetDirectory: string
    ) {
        for (const name of fs.readdir(sourceDirectory)) {
            if (name === '.' || name === '..' || name === POSTMASTER_PID) {
                continue
            }
            const source = posix.join(sourceDirectory, name)
            const target = resolve(
                targetDirectory,
                posix.relative(sourceDirectory, source)
            )
            const stats = fs.stat(source)
            if (fs.isDir(stats.mode)) {
                await mkdir(target, { recursive: true })
                await this.copyToDisk(fs, source, target)
                continue
            }
            if (fs.isFile(stats.mode)) {
                await mkdir(dirname(target), { recursive: true })
                // Windows 上逐文件 fsync 会让一次小写入阻塞数十秒。
                const data = fs.readFile(source)
                if (process.platform === 'win32') {
                    await writeFile(target, data)
                    continue
                }
                const handle = await openFile(target, 'w')
                try {
                    await handle.writeFile(data)
                    await handle.sync()
                } finally {
                    await handle.close()
                }
            }
        }
    }
}
