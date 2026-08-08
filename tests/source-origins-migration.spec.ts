import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    createdAt: new Date(),
    updatedAt: new Date()
})

const defineLegacyEntryTable = (ctx: Context) => {
    ctx.model.extend(
        'living_memory_entry',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            type: 'string(32)',
            status: 'string(16)',
            content: 'text',
            keywords: 'json',
            summary: 'text',
            sentiment: 'text',
            importance: 'double',
            sourceConversationId: 'string(255)',
            embedding: 'json',
            embeddingModelId: 'string(255)',
            createdAt: 'timestamp',
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )
}

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

it('repairs the legacy SQLite json default after applying current tables', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'livingmemory-migration-'))
    const databasePath = join(baseDir, 'legacy.db')
    try {
        const legacyCtx = new Context({ baseDir })
        legacyCtx.plugin(SQLiteDriver, { path: databasePath })
        defineLegacyEntryTable(legacyCtx)
        await legacyCtx.start()

        try {
            const legacyEntry = createEntry('legacy-schema', undefined)
            delete (legacyEntry as { sourceOrigins?: unknown }).sourceOrigins
            await legacyCtx.database.create(
                'living_memory_entry',
                legacyEntry as never
            )
            const [storedLegacyEntry] = await legacyCtx.database.get(
                'living_memory_entry',
                { id: 'legacy-schema' }
            )
            assert.equal(storedLegacyEntry.sourceOrigins, undefined)
        } finally {
            await (legacyCtx.database.drivers[0] as SQLiteDriver)._export()
            await legacyCtx.stop()
        }

        const currentCtx = new Context({ baseDir })
        currentCtx.plugin(SQLiteDriver, { path: databasePath })
        const repository = new LivingMemoryRepository(currentCtx)
        repository.defineTables()
        await currentCtx.start()

        try {
            assert.equal(await repository.migrateMemorySourceOriginsArray(), 0)
            assert.deepEqual(
                (await repository.getEntryById('legacy-schema'))?.sourceOrigins,
                []
            )
            assert.equal(
                (await repository.getEntryById('legacy-schema'))
                    ?.isConsolidated,
                false
            )

            const currentEntry = createEntry('current-schema', undefined)
            delete (currentEntry as { sourceOrigins?: unknown }).sourceOrigins
            await currentCtx.database.create(
                'living_memory_entry',
                currentEntry as never
            )
            assert.deepEqual(
                (await repository.getEntryById('current-schema'))
                    ?.sourceOrigins,
                []
            )
        } finally {
            await currentCtx.stop()
        }
    } finally {
        await rm(baseDir, { recursive: true, force: true })
    }
})
