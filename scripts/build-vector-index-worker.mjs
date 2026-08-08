import { build } from 'esbuild'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(projectRoot, 'lib', 'vector-index-worker.mjs')

await build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/service/vector_index/worker/entry.ts'],
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    external: ['better-sqlite3', 'sqlite-vec']
})

const output = await stat(outputPath)
if (!output.isFile() || output.size === 0) {
    throw new Error(`vector index worker build output is invalid: ${outputPath}`)
}
