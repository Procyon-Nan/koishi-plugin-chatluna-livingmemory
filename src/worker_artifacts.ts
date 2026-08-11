import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let moduleDirectory: string
if (typeof __dirname === 'undefined') {
    moduleDirectory = dirname(fileURLToPath(import.meta.url))
} else {
    moduleDirectory = __dirname
}
// 源码位于 src，构建包位于 lib；两种入口的 ../lib 均指向 Worker 产物目录。
const workerDirectory = resolve(moduleDirectory, '..', 'lib')

export const resolveWorkerArtifact = (filename: string) =>
    resolve(workerDirectory, filename)
