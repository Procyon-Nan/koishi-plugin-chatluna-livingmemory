/// <reference types="mocha" />

import assert from 'node:assert/strict'
import { Context } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository'

const createEntry = (id: string, sourceOrigins: unknown) => ({
    id,
    presetId: 'test-preset',
    type: 'other' as const,
    status: 'active' as const,
    content: id,
    keywords: [],
    summary: null,
    sentiment: null,
    importance: null,
    sourceConversationId: 'test-conversation',
    sourceOrigins,
    embedding: null,
    embeddingModelId: null,
    createdAt: new Date(),
    updatedAt: new Date()
})

it('migrates legacy sourceOrigins objects once and preserves arrays', async () => {
    const ctx = new Context({ baseDir: process.cwd() })
    ctx.plugin(SQLiteDriver, { path: ':memory:' })
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    await ctx.start()

    try {
        await ctx.database.create(
            'living_memory_entry',
            createEntry('legacy', {}) as never
        )
        await ctx.database.create(
            'living_memory_entry',
            createEntry('current', [
                {
                    messages: [{ role: 'user', content: 'hello' }]
                }
            ]) as never
        )

        assert.equal(await repository.migrateMemorySourceOriginsArray(), 1)

        const entries = await ctx.database.get('living_memory_entry', {})
        const entryById = new Map(entries.map((entry) => [entry.id, entry]))
        assert.deepEqual(entryById.get('legacy')?.sourceOrigins, [])
        assert.deepEqual(entryById.get('current')?.sourceOrigins, [
            {
                messages: [{ role: 'user', content: 'hello' }]
            }
        ])
        assert.equal(await repository.migrateMemorySourceOriginsArray(), 0)
        assert.equal(
            (
                await ctx.database.get('living_memory_migration', {
                    id: 'source-origins-array-v1'
                })
            ).length,
            1
        )
    } finally {
        await ctx.stop()
    }
})
