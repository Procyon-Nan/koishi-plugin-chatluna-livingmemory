import assert from 'node:assert/strict'
import { Context } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository'

it(
    'clears legacy JSON vectors after the vector index migration completes',
    async () => {
        const ctx = new Context({ baseDir: process.cwd() })
        ctx.plugin(SQLiteDriver, { path: ':memory:' })
        const repository = new LivingMemoryRepository(ctx)
        repository.defineTables()
        await ctx.start()

        try {
            const memory = await repository.createMemory(
                {
                    conversationId: 'conversation-a',
                    presetId: 'preset-a'
                },
                {
                    type: 'fact',
                    content: 'legacy memory'
                }
            )
            await ctx.database.set(
                'living_memory_entry',
                { id: memory.id },
                {
                    embedding: [1, 0, 0],
                    embeddingModelId: 'model-a'
                }
            )

            assert.equal(await repository.hasMigratedLegacyEmbeddings(), false)
            const beforeMigration = await repository.getEntryById(memory.id)
            assert.equal(
                Object.hasOwn(beforeMigration ?? {}, 'embedding'),
                false
            )
            assert.equal(
                Object.hasOwn(beforeMigration ?? {}, 'embeddingModelId'),
                false
            )
            await repository.completeLegacyEmbeddingMigration()
            assert.equal(await repository.hasMigratedLegacyEmbeddings(), true)

            const [stored] = await ctx.database.get('living_memory_entry', {
                id: memory.id
            })
            assert.equal(stored.embedding, null)
            assert.equal(stored.embeddingModelId, null)

            await repository.completeLegacyEmbeddingMigration()
            assert.equal(
                (
                    await ctx.database.get('living_memory_migration', {
                        id: 'legacy-embedding-vector-index-v1'
                    })
                ).length,
                1
            )
        } finally {
            await ctx.stop()
        }
    }
)
