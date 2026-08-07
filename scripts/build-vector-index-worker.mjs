import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/service/vector_index/worker/entry.ts'],
    outfile: 'lib/vector-index-worker.mjs',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    external: ['better-sqlite3', 'sqlite-vec']
})
