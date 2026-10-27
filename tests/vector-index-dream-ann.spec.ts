import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { vi } from 'vitest'
import type { DreamNeighborQuery } from '../src/contracts/vector_index'
import {
    buildDreamAnnIndex,
    isDreamAnnReady,
    queryDreamNeighbors
} from '../src/service/vector_index/worker/dream_ann'
import { createVectorIndexSchema } from '../src/service/vector_index/worker/schema'
import { queryVectorIndexKnn } from '../src/service/vector_index/worker/queries'

it('keeps exact recall and accepts indexed and exact candidate queries with transaction-local settings', async () => {
    const database = await PGlite.create({ extensions: { vector } })
    try {
        await database.exec('CREATE EXTENSION vector')
        await createVectorIndexSchema(database, {
            schemaVersion: 5,
            embeddingModelId: 'test',
            dimension: 3,
            storageEngine: 'pglite-pgvector',
            vectorExtensionVersion: '0.8.7',
            generation: 'generation-1',
            builtAt: Date.now()
        })
        await database.exec(`
            INSERT INTO lm_index_memory
            SELECT i::text, CASE WHEN i % 10 = 0 THEN 'other' ELSE 'preset' END,
                   'conversation', CASE WHEN i % 7 = 0 THEN 'archived' ELSE 'active' END,
                   'fact', true, 'hash-' || i, 'keywords', 0,
                   ('[1,' || i * 0.001 || ',0]')::vector
            FROM generate_series(1, 500) i;
        `)
        const exactQuery = {
            presetId: 'preset',
            conversationId: 'conversation',
            types: null,
            memoryStatus: 'all' as const,
            vector: new Float32Array([1, 0, 0]),
            limit: 20
        }
        const baseline = await queryVectorIndexKnn(database, exactQuery)
        const query: DreamNeighborQuery = {
            sourceIndex: 0,
            presetId: 'preset',
            generation: 'generation-1',
            sourceMemoryId: '1',
            vector: new Float32Array([1, 0, 0]),
            limit: 10,
            efSearch: 100
        }
        const cancellation = new Int32Array(new SharedArrayBuffer(4))
        assert.equal(
            (await queryDreamNeighbors(database, [query], cancellation)).reason,
            'index-absent'
        )
        assert.deepEqual(await buildDreamAnnIndex(database), { built: true })
        assert.equal(await isDreamAnnReady(database), true)
        assert.deepEqual(await buildDreamAnnIndex(database), { built: false })

        // 查询计划的两个分支分别固定；生产查询沿用优化器选择。
        await database.exec(
            'SET enable_seqscan = off; SET enable_bitmapscan = off; SET enable_sort = off'
        )
        assert.deepEqual(
            await queryVectorIndexKnn(database, exactQuery),
            baseline
        )
        const beforeSettings = await database.query('SHOW hnsw.ef_search')
        const result = await queryDreamNeighbors(
            database,
            [query],
            cancellation
        )
        assert.equal(result.available, true)
        assert.equal(result.completed, 1)
        assert.deepEqual(
            result.rows[0].hits.map((hit) => hit.memoryId),
            ['2', '3', '4', '5', '6', '8', '9', '11', '12', '13']
        )
        assert.equal(result.rows[0].hits[0].contentHash, 'hash-2')
        assert.deepEqual(
            (await database.query('SHOW hnsw.ef_search')).rows,
            beforeSettings.rows
        )

        const clock = vi.spyOn(performance, 'now')
        clock.mockReturnValueOnce(0).mockReturnValue(26)
        try {
            const page = await queryDreamNeighbors(
                database,
                [query, { ...query, sourceIndex: 1 }],
                cancellation
            )
            assert.equal(page.completed, 1)
            assert.equal(page.reason, 'budget')
        } finally {
            clock.mockRestore()
        }
        Atomics.store(cancellation, 0, 1)
        await assert.rejects(
            queryDreamNeighbors(database, [query], cancellation),
            /cancelled/u
        )
        Atomics.store(cancellation, 0, 0)

        await database.exec(`
            UPDATE lm_index_memory SET status = 'archived' WHERE memory_id = '2';
            UPDATE lm_index_memory SET content_hash = 'changed', embedding = '[1,0.0015,0]'
            WHERE memory_id = '3';
            INSERT INTO lm_index_memory VALUES (
                'new', 'preset', 'conversation', 'active', 'fact', true,
                'hash-new', 'keywords', 0, '[1,0,0]'
            );
        `)
        const changed = await queryDreamNeighbors(
            database,
            [query],
            cancellation
        )
        assert.deepEqual(
            changed.rows[0].hits
                .slice(0, 2)
                .map((hit) => [hit.memoryId, hit.contentHash]),
            [
                ['new', 'hash-new'],
                ['3', 'changed']
            ]
        )
        assert.equal(
            changed.rows[0].hits.some((hit) => hit.memoryId === '2'),
            false
        )

        await database.exec(
            'SET enable_indexscan = off; SET enable_seqscan = on; SET enable_sort = on'
        )
        const exactResult = await queryDreamNeighbors(
            database,
            [query],
            cancellation
        )
        assert.equal(exactResult.completed, 1)
        assert.equal(exactResult.available, true)
        assert.deepEqual(
            exactResult.rows[0].hits.map((hit) => hit.memoryId),
            ['new', '3', '4', '5', '6', '8', '9', '11', '12', '13']
        )
    } finally {
        await database.close()
    }
}, 60_000)
