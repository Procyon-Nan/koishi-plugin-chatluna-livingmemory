import { ensureWorkersBuilt } from './worker-test-utils'

export const setup = async () => {
    await ensureWorkersBuilt()
}
