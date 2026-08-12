import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const benchmarkPath = resolve(
    process.cwd(),
    'scripts',
    'vector-index-benchmark.mjs'
)

interface BenchmarkWorkloadResult {
    filteredCandidateCount: number
    keywordCandidateCount: number | null
    semanticCandidateCount: number | null
    semanticKeywordOverlapCount: number | null
    keywordDistanceCandidateCount: number | null
    avoidedKeywordDistanceCount: number | null
    queryCount: number
    searchTextCount: number
    durationMilliseconds: {
        minimum: number
        mean: number
        p50: number
        p95: number
        maximum: number
        workerOccupiedTotal: number
    }
    cpuMilliseconds: {
        userMilliseconds: number
        systemMilliseconds: number
        totalMilliseconds: number
    }
    exactTopKMemoryIds: string[]
}

interface BenchmarkResult {
    config: {
        memoryCount: number
        dimension: number
        queryCount: number
        presetCount: number
        activeRatio: number
        consolidatedRatio: number
        memoryTypeDistribution: string
        keywordVocabularySize: number
        keywordHotRatio: number
        searchTextCount: number
        workload: string
        seed: number
        analyze: boolean
    }
    schema: {
        schemaVersion: number
        storageEngine: string
        vectorExtensionVersion: string
    }
    build: {
        schemaMilliseconds: number
        dataMilliseconds: number
        cpuMilliseconds: {
            totalMilliseconds: number
        }
        analyzeMilliseconds: number | null
        databaseFileMiB: number
    }
    memory: {
        baselineRssMiB: number
        peakRssMiB: number
    }
    workloads: Record<string, BenchmarkWorkloadResult>
}

const runBenchmark = async () => {
    const { stdout } = await execFileAsync(
        process.execPath,
        [
            benchmarkPath,
            '--memory-count=36',
            '--dimension=3',
            '--query-count=1',
            '--preset-count=3',
            '--active-ratio=0.75',
            '--consolidated-ratio=0.5',
            '--memory-type-distribution=fact:4,preference:3,context:2,plan:1',
            '--keyword-vocabulary-size=8',
            '--keyword-hot-ratio=0.75',
            '--search-text-count=2',
            '--workload=all',
            '--seed=123456',
            '--analyze=true'
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 }
    )
    return JSON.parse(stdout) as BenchmarkResult
}

it('benchmarks production vector-index workloads reproducibly', async function () {
    this.timeout(60_000)
    const first = await runBenchmark()
    const second = await runBenchmark()

    assert.deepEqual(first.config, second.config)
    assert.deepEqual(first.config, {
        memoryCount: 36,
        dimension: 3,
        queryCount: 1,
        presetCount: 3,
        activeRatio: 0.75,
        consolidatedRatio: 0.5,
        memoryTypeDistribution: 'fact:4,preference:3,context:2,plan:1',
        keywordVocabularySize: 8,
        keywordHotRatio: 0.75,
        searchTextCount: 2,
        workload: 'all',
        seed: 123456,
        analyze: true
    })
    assert.equal(first.schema.storageEngine, 'pglite-pgvector')
    assert.match(first.schema.vectorExtensionVersion, /^\d+\.\d+\.\d+$/u)
    assert.ok(first.schema.schemaVersion > 0)
    assert.ok(first.build.schemaMilliseconds >= 0)
    assert.ok(first.build.dataMilliseconds >= 0)
    assert.ok(first.build.cpuMilliseconds.totalMilliseconds >= 0)
    assert.ok(first.build.analyzeMilliseconds != null)
    assert.ok(first.build.analyzeMilliseconds >= 0)
    assert.ok(first.build.databaseFileMiB > 0)
    assert.ok(first.memory.baselineRssMiB > 0)
    assert.ok(first.memory.peakRssMiB >= first.memory.baselineRssMiB)

    assert.deepEqual(Object.keys(first.workloads).sort(), [
        'hybrid',
        'incremental',
        'semantic'
    ])
    for (const name of Object.keys(first.workloads)) {
        const firstWorkload = first.workloads[name]
        const secondWorkload = second.workloads[name]
        assert.equal(firstWorkload.queryCount, 1)
        assert.equal(firstWorkload.searchTextCount, 2)
        assert.ok(firstWorkload.filteredCandidateCount > 0)
        assert.ok(firstWorkload.durationMilliseconds.minimum >= 0)
        assert.ok(firstWorkload.durationMilliseconds.mean >= 0)
        assert.ok(firstWorkload.durationMilliseconds.p50 >= 0)
        assert.ok(firstWorkload.durationMilliseconds.p95 >= 0)
        assert.ok(firstWorkload.durationMilliseconds.maximum >= 0)
        assert.ok(firstWorkload.durationMilliseconds.workerOccupiedTotal >= 0)
        assert.ok(firstWorkload.cpuMilliseconds.totalMilliseconds >= 0)
        assert.ok(firstWorkload.exactTopKMemoryIds.length > 0)
        assert.deepEqual(
            firstWorkload.exactTopKMemoryIds,
            secondWorkload.exactTopKMemoryIds
        )
    }

    assert.ok(first.workloads.hybrid.keywordCandidateCount != null)
    assert.ok(first.workloads.hybrid.keywordCandidateCount > 0)
    assert.ok(first.workloads.hybrid.semanticCandidateCount != null)
    assert.ok(first.workloads.hybrid.semanticCandidateCount > 0)
    assert.ok(first.workloads.hybrid.semanticKeywordOverlapCount != null)
    assert.ok(first.workloads.hybrid.semanticKeywordOverlapCount > 0)
    assert.equal(
        first.workloads.hybrid.keywordDistanceCandidateCount,
        first.workloads.hybrid.keywordCandidateCount -
            first.workloads.hybrid.semanticKeywordOverlapCount
    )
    assert.equal(
        first.workloads.hybrid.avoidedKeywordDistanceCount,
        first.workloads.hybrid.semanticKeywordOverlapCount
    )
    assert.equal(first.workloads.semantic.keywordCandidateCount, null)
    assert.equal(first.workloads.semantic.semanticCandidateCount, null)
    assert.equal(first.workloads.semantic.semanticKeywordOverlapCount, null)
    assert.equal(first.workloads.semantic.keywordDistanceCandidateCount, null)
    assert.equal(first.workloads.semantic.avoidedKeywordDistanceCount, null)
    assert.equal(first.workloads.incremental.keywordCandidateCount, null)
    assert.equal(first.workloads.incremental.semanticCandidateCount, null)
    assert.equal(first.workloads.incremental.semanticKeywordOverlapCount, null)
    assert.equal(
        first.workloads.incremental.keywordDistanceCandidateCount,
        null
    )
    assert.equal(first.workloads.incremental.avoidedKeywordDistanceCount, null)
})
