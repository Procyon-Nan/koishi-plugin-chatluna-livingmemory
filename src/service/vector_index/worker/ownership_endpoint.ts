import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { LivingMemoryVectorIndexError } from '../errors'

const ENDPOINT_PREFIX = 'chatluna-livingmemory-vector-index-'

const errorCode = (error: unknown) =>
    error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null

const identifyDirectory = async (databaseDirectory: string) => {
    const absoluteDirectory = resolve(databaseDirectory)
    let identity: string
    try {
        identity = await realpath(absoluteDirectory)
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
            throw error
        }
        const parentDirectory = dirname(absoluteDirectory)
        await mkdir(parentDirectory, { recursive: true })
        identity = join(
            await realpath(parentDirectory),
            basename(absoluteDirectory)
        )
    }
    identity = identity.replaceAll('\\', '/')
    if (process.platform === 'win32') {
        identity = identity.toLowerCase()
    }
    return identity
}

const createEndpointAddress = (hash: string) => {
    const name = `${ENDPOINT_PREFIX}${hash}`
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\${name}`
    }
    if (process.platform === 'linux') {
        return `\0${name}`
    }
    throw new LivingMemoryVectorIndexError(
        'lock-unavailable',
        'unavailable',
        `vector index ownership is not supported on ${process.platform}`
    )
}

export class LivingMemoryVectorIndexOwnershipEndpoint {
    private server: Server | null = null

    async acquire(databaseDirectory: string) {
        const identity = await identifyDirectory(databaseDirectory)
        if (this.server !== null) {
            throw new Error('vector index worker already owns a directory')
        }

        const hash = createHash('sha256').update(identity).digest('hex')
        const address = createEndpointAddress(hash)
        const server = createServer((socket) => socket.destroy())
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => {
                    server.removeListener('listening', onListening)
                    reject(error)
                }
                const onListening = () => {
                    server.removeListener('error', onError)
                    resolve()
                }
                server.once('error', onError)
                server.once('listening', onListening)
                server.listen(address)
            })
        } catch (error) {
            const code = errorCode(error)
            throw new LivingMemoryVectorIndexError(
                code === 'EADDRINUSE' ? 'lock-conflict' : 'lock-unavailable',
                'unavailable',
                code === 'EADDRINUSE'
                    ? `vector index directory is owned by another process: ` +
                          identity
                    : `vector index ownership endpoint is unavailable: ` +
                          identity,
                { cause: error }
            )
        }
        this.server = server
    }

    assertOwned() {
        if (this.server === null) {
            throw new LivingMemoryVectorIndexError(
                'lock-unavailable',
                'unavailable',
                'vector index worker does not own the database directory'
            )
        }
    }

    async release() {
        const server = this.server
        if (server === null) {
            return
        }
        this.server = null
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error === undefined) {
                    resolve()
                } else {
                    reject(error)
                }
            })
        })
    }
}
