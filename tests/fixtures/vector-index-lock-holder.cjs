const {
    LivingMemoryVectorIndexOwnershipLock
} = require('../../src/service/vector_index/ownership_lock.ts')

const [lockPath, mode] = process.argv.slice(2)

const run = async () => {
    const lock = new LivingMemoryVectorIndexOwnershipLock(lockPath)
    await lock.acquire()
    process.send?.({ type: 'acquired' })

    if (mode === 'exit') {
        return
    }

    process.on('message', async (message) => {
        if (message !== 'release') {
            return
        }
        await lock.release()
        process.exit(0)
    })
}

run().catch((error) => {
    console.error(error)
    process.exit(1)
})
