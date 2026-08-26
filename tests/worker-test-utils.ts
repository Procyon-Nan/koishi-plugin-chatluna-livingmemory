import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export const vectorIndexWorkerPath = resolve(
    projectRoot,
    'lib',
    'vector-index-worker.mjs'
)

export const dreamWorkerPath = resolve(
    projectRoot,
    'lib',
    'dream-hdbscan-worker.mjs'
)

let workerBuild: Promise<unknown> | null = null

export const ensureWorkersBuilt = () => {
    if (workerBuild === null) {
        workerBuild = executeFile(process.execPath, [
            resolve(projectRoot, 'scripts', 'build-workers.mjs')
        ])
    }
    return workerBuild
}
