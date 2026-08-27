import { Context } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository'

export const createTestContext = (baseDir = process.cwd()) => {
    const ctx = new Context()
    ctx.baseDir = baseDir
    return ctx
}

export const withLivingMemoryRepository = async (
    callback: (
        ctx: Context,
        repository: LivingMemoryRepository
    ) => Promise<void>
) => {
    const ctx = createTestContext()
    ctx.plugin(SQLiteDriver, { path: ':memory:' })
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    await ctx.start()

    try {
        await callback(ctx, repository)
    } finally {
        await ctx.stop()
    }
}
