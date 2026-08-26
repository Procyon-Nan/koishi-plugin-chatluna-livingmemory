import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { LivingMemoryRepository } from '../src/service/persistence/repository'
import type { LivingMemoryEntryTableRecord } from '../src/service/persistence/types'
import { createTestContext } from './persistence-test-utils'

interface LegacyEntryInput {
    id: string
    presetId: string
    type: 'other'
    status: 'active'
    content: string
    keywords: string[]
    summary: null
    sentiment: null
    importance: null
    sourceConversationId: string
    sourceOrigins?: unknown
    createdAt: Date
    updatedAt: Date
}

const createEntry = (id: string, sourceOrigins: unknown): LegacyEntryInput => ({
    id,
    presetId: 'test-preset',
    type: 'other',
    status: 'active',
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

const insertLegacyEntry = async (ctx: Context, entry: LegacyEntryInput) => {
    await ctx.database.create(
        'living_memory_entry',
        entry as unknown as Partial<LivingMemoryEntryTableRecord>
    )
}

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
    const ctx = createTestContext()
    ctx.plugin(SQLiteDriver, { path: ':memory:' })
    const repository = new LivingMemoryRepository(ctx)
    repository.defineTables()
    await ctx.start()

    try {
        await insertLegacyEntry(ctx, createEntry('legacy', {}))
        await insertLegacyEntry(
            ctx,
            createEntry('current', [
                {
                    messages: [{ role: 'user', content: 'hello' }]
                }
            ])
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
        const legacyCtx = createTestContext(baseDir)
        legacyCtx.plugin(SQLiteDriver, { path: databasePath })
        defineLegacyEntryTable(legacyCtx)
        await legacyCtx.start()

        try {
            const { sourceOrigins: _sourceOrigins, ...legacyEntry } =
                createEntry('legacy-schema', undefined)
            await insertLegacyEntry(legacyCtx, legacyEntry)
            const [storedLegacyEntry] = await legacyCtx.database.get(
                'living_memory_entry',
                {
                    id: 'legacy-schema'
                }
            )
            assert.equal(storedLegacyEntry.sourceOrigins, undefined)
        } finally {
            const [driver] = legacyCtx.database.drivers
            assert.ok(driver instanceof SQLiteDriver)
            await driver._export()
            await legacyCtx.stop()
        }

        const currentCtx = createTestContext(baseDir)
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

            const { sourceOrigins: _sourceOrigins, ...currentEntry } =
                createEntry('current-schema', undefined)
            await insertLegacyEntry(currentCtx, currentEntry)
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
