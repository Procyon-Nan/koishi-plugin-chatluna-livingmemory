import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const projectRoot = resolve(__dirname, '..')

export const vectorIndexWorkerPath = resolve(
    projectRoot,
    'lib',
    'vector-index-worker.mjs'
)

let workerBuild: Promise<unknown> | null = null

export const ensureVectorIndexWorkerBuilt = () => {
    if (workerBuild === null) {
        workerBuild = executeFile(process.execPath, [
            resolve(projectRoot, 'scripts', 'build-vector-index-worker.mjs')
        ])
    }
    return workerBuild
}
