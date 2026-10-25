import { parentPort } from 'node:worker_threads'
import { LivingMemoryVectorIndexDatabase } from './database'
import { serializeError, startVectorIndexWorker } from './runtime'
import type { VectorIndexWorkerWarning } from '../worker_protocol'

const port = parentPort!
startVectorIndexWorker(
    port,
    new LivingMemoryVectorIndexDatabase({
        reportWarning: (warning) =>
            port.postMessage({
                type: 'warning',
                error: serializeError(warning)
            } satisfies VectorIndexWorkerWarning)
    })
)
