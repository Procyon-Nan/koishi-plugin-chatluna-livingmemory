import assert from 'node:assert/strict'
import { access, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { VectorIndexDirectorySwitch } from '../src/service/vector_index/directory_switch'
import { LivingMemoryVectorIndexWorkerClient } from '../src/service/vector_index/worker_client'
import { ensureWorkersBuilt, vectorIndexWorkerPath } from './worker-test-utils'

const workerPath = vectorIndexWorkerPath

before(async function () {
    this.timeout(30_000)
    await ensureWorkersBuilt()
})

const withTemporaryDirectory = async (
    callback: (directory: string) => Promise<void>
) => {
    const directory = await mkdtemp(
        resolve(tmpdir(), 'living-memory-vector-switch-test-')
    )
    try {
        await callback(directory)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

it('switches a PGlite directory after its worker exits', async function () {
    if (process.platform !== 'win32') {
        this.skip()
    }
    await withTemporaryDirectory(async (directory) => {
        const activePath = resolve(directory, 'vector-index.pglite')
        const rebuildPath = resolve(directory, 'vector-index.rebuild.pglite')
        const previousPath = resolve(directory, 'vector-index.previous.pglite')
        const worker = new LivingMemoryVectorIndexWorkerClient(workerPath)

        await worker.open(activePath, previousPath)
        await worker.createRebuildFile(rebuildPath, {
            schemaVersion: 3,
            embeddingModelId: 'model-a',
            dimension: 3,
            storageEngine: 'pglite-pgvector',
            vectorExtensionVersion: '0.8.1',
            generation: 'windows-switch',
            builtAt: Date.now()
        })
        await worker.prepareRebuild(0)
        await worker.dispose()

        const switcher = new VectorIndexDirectorySwitch()
        await switcher.activate(activePath, rebuildPath, previousPath)

        const reopened = new LivingMemoryVectorIndexWorkerClient(workerPath)
        const inspection = await reopened.openCandidate(activePath)
        assert.equal(inspection.manifest?.generation, 'windows-switch')
        await reopened.dispose()
    })
})

it('rolls back the active directory when candidate activation fails', async () => {
    await withTemporaryDirectory(async (directory) => {
        const activePath = resolve(directory, 'active')
        const rebuildPath = resolve(directory, 'rebuild')
        const previousPath = resolve(directory, 'previous')
        await writeFile(activePath, 'active')
        await writeFile(rebuildPath, 'rebuild')
        const injectedError = new Error('injected activation failure')
        const switcher = new VectorIndexDirectorySwitch({
            renameDirectory: async (source, destination) => {
                if (source === rebuildPath) {
                    throw injectedError
                }
                await rename(source, destination)
            }
        })

        await assert.rejects(
            switcher.activate(activePath, rebuildPath, previousPath),
            injectedError
        )
        await access(activePath)
        await access(rebuildPath)
        await assert.rejects(access(previousPath), { code: 'ENOENT' })
    })
})

it('keeps an activated index when previous cleanup fails', async () => {
    await withTemporaryDirectory(async (directory) => {
        const activePath = resolve(directory, 'active')
        const rebuildPath = resolve(directory, 'rebuild')
        const previousPath = resolve(directory, 'previous')
        await writeFile(activePath, 'active')
        await writeFile(rebuildPath, 'rebuild')
        const cleanupError = new Error('injected cleanup failure')
        const warnings: Error[] = []
        const switcher = new VectorIndexDirectorySwitch({
            removeDirectory: async () => {
                throw cleanupError
            },
            reportWarning: (warning) => warnings.push(warning)
        })

        await switcher.activate(activePath, rebuildPath, previousPath)
        await switcher.cleanup(
            previousPath,
            'previous index cleanup after rebuild'
        )

        await access(activePath)
        await access(previousPath)
        assert.equal(warnings.length, 1)
        assert.equal(warnings[0].cause, cleanupError)
    })
})

it('restores the candidate when rollback cannot restore the previous directory', async () => {
    await withTemporaryDirectory(async (directory) => {
        const activePath = resolve(directory, 'active')
        const rebuildPath = resolve(directory, 'rebuild')
        const previousPath = resolve(directory, 'previous')
        await writeFile(activePath, 'active')
        await writeFile(rebuildPath, 'rebuild')
        const rollbackError = new Error('injected rollback failure')
        const switcher = new VectorIndexDirectorySwitch({
            renameDirectory: async (source, destination) => {
                if (source === previousPath && destination === activePath) {
                    throw rollbackError
                }
                await rename(source, destination)
            },
            waitBeforeRetry: async () => {}
        })
        const activation = await switcher.activate(
            activePath,
            rebuildPath,
            previousPath
        )

        await assert.rejects(switcher.rollback(activation), rollbackError)
        await access(activePath)
        await access(previousPath)
        await assert.rejects(access(rebuildPath), { code: 'ENOENT' })
    })
})
