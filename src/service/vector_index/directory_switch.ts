import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { summarizeError } from '../shared/utils'

const RENAME_RETRY_DELAYS = [50, 100, 200, 400, 800, 1_000]

const isTransientRenameError = (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' ||
        error.code === 'EACCES' ||
        error.code === 'EBUSY')

interface VectorIndexDirectorySwitchOptions {
    renameDirectory?: (source: string, destination: string) => Promise<void>
    removeDirectory?: (directory: string) => Promise<void>
    waitBeforeRetry?: (milliseconds: number) => Promise<void>
    reportWarning?: (warning: Error) => void
}

export interface VectorIndexDirectoryActivation {
    activeDirectory: string
    rebuildDirectory: string
    previousDirectory: string
    hadActiveDirectory: boolean
}

export class VectorIndexDirectorySwitch {
    private readonly renameDirectory: (
        source: string,
        destination: string
    ) => Promise<void>

    private readonly removeDirectory: (directory: string) => Promise<void>
    private readonly waitBeforeRetry: (milliseconds: number) => Promise<void>
    private readonly reportWarning: (warning: Error) => void

    constructor(options: VectorIndexDirectorySwitchOptions = {}) {
        this.renameDirectory = options.renameDirectory ?? rename
        this.removeDirectory =
            options.removeDirectory ??
            ((directory) => rm(directory, { recursive: true, force: true }))
        this.waitBeforeRetry = options.waitBeforeRetry ?? delay
        this.reportWarning =
            options.reportWarning ?? ((warning) => process.emitWarning(warning))
    }

    async activate(
        activeDirectory: string,
        rebuildDirectory: string,
        previousDirectory: string
    ) {
        if (existsSync(previousDirectory)) {
            throw new Error(
                `vector index previous directory already exists: ${previousDirectory}`
            )
        }

        let activeMoved = false
        try {
            if (existsSync(activeDirectory)) {
                await this.move(activeDirectory, previousDirectory)
                activeMoved = true
            }
            await this.move(rebuildDirectory, activeDirectory)
            return {
                activeDirectory,
                rebuildDirectory,
                previousDirectory,
                hadActiveDirectory: activeMoved
            } satisfies VectorIndexDirectoryActivation
        } catch (error) {
            if (activeMoved && existsSync(previousDirectory)) {
                try {
                    await this.move(previousDirectory, activeDirectory)
                } catch (rollbackError) {
                    throw new Error(
                        `vector index directory activation failed: ` +
                            `${summarizeError(error)}; rollback failed: ` +
                            summarizeError(rollbackError),
                        { cause: error }
                    )
                }
            }
            throw error
        }
    }

    async rollback(activation: VectorIndexDirectoryActivation) {
        if (existsSync(activation.activeDirectory)) {
            await this.move(
                activation.activeDirectory,
                activation.rebuildDirectory
            )
        }
        if (activation.hadActiveDirectory) {
            try {
                await this.move(
                    activation.previousDirectory,
                    activation.activeDirectory
                )
            } catch (error) {
                if (existsSync(activation.rebuildDirectory)) {
                    try {
                        await this.move(
                            activation.rebuildDirectory,
                            activation.activeDirectory
                        )
                    } catch (restoreCandidateError) {
                        throw new Error(
                            `vector index directory rollback failed: ` +
                                `${summarizeError(error)}; candidate restore failed: ` +
                                summarizeError(restoreCandidateError),
                            { cause: error }
                        )
                    }
                }
                throw error
            }
        }
    }

    cleanup(directory: string, operation: string) {
        if (!existsSync(directory)) {
            return Promise.resolve()
        }
        return this.removeDirectory(directory).catch((error) => {
            this.reportWarning(
                new Error(
                    `vector index cleanup failed: operation=${operation} ` +
                        `directory=${directory}: ${summarizeError(error)}`,
                    { cause: error }
                )
            )
        })
    }

    private async move(source: string, destination: string) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                await this.renameDirectory(source, destination)
                return
            } catch (error) {
                const retryDelay = RENAME_RETRY_DELAYS[attempt]
                if (
                    retryDelay === undefined ||
                    !isTransientRenameError(error)
                ) {
                    throw error
                }
                await this.waitBeforeRetry(retryDelay)
            }
        }
    }
}
