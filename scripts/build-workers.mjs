import { build } from 'esbuild'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(projectRoot, 'lib')
const outputs = [
    resolve(outputDirectory, 'vector-index-worker.mjs'),
    resolve(outputDirectory, 'dream-hdbscan-worker.mjs')
]

await build({
    absWorkingDir: projectRoot,
    entryPoints: {
        'vector-index-worker': 'src/service/vector_index/worker/entry.ts',
        'dream-hdbscan-worker': 'src/service/workflows/dream/worker/entry.ts'
    },
    outdir: outputDirectory,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    external: ['better-sqlite3', 'sqlite-vec']
})

for (const outputPath of outputs) {
    const output = await stat(outputPath)
    if (!output.isFile() || output.size === 0) {
        throw new Error(`worker build output is invalid: ${outputPath}`)
    }
}
