import { parentPort } from 'node:worker_threads'
import { LivingMemoryVectorIndexDatabase } from './database'
import { startVectorIndexWorker } from './runtime'

if (parentPort === null) {
    throw new Error('vector index worker requires a parent port')
}

startVectorIndexWorker(parentPort, new LivingMemoryVectorIndexDatabase())
