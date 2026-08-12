import { performance } from 'node:perf_hooks'
import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export const createRandom = (seed) => {
    let state = seed >>> 0
    return () => {
        state += 0x6d2b79f5
        let value = state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
    }
}

const createVector = (dimension, random) => {
    const values = new Float32Array(dimension)
    let squaredNorm = 0
    for (let index = 0; index < dimension; index++) {
        const value = random() * 2 - 1
        values[index] = value
        squaredNorm += value * value
    }
    const norm = Math.sqrt(squaredNorm)
    if (norm === 0) {
        values[0] = 1
        return values
    }
    for (let index = 0; index < dimension; index++) {
        values[index] /= norm
    }
    return values
}

export const toPgVector = (values) => `[${Array.from(values).join(',')}]`

const createKeywords = (options, random) => {
    const hotVocabularySize = Math.max(
        1,
        Math.floor(options.keywordVocabularySize * 0.1)
    )
    const primaryVocabularySize =
        random() < options.keywordHotRatio
            ? hotVocabularySize
            : options.keywordVocabularySize
    const primary = Math.floor(random() * primaryVocabularySize)
    let secondary = Math.floor(random() * options.keywordVocabularySize)
    if (secondary === primary) {
        secondary = (secondary + 1) % options.keywordVocabularySize
    }
    return [`keyword-${primary}`, `keyword-${secondary}`].sort()
}

export const createMemory = (index, options, typeDistribution, random) => {
    const keywords = createKeywords(options, random)
    const typeRoll = random()
    return {
        id: `memory-${index.toString().padStart(8, '0')}`,
        presetId: `benchmark-preset-${index % options.presetCount}`,
        status: random() < options.activeRatio ? 'active' : 'archived',
        type: typeDistribution.find(({ maximum }) => typeRoll < maximum).type,
        isConsolidated: random() < options.consolidatedRatio,
        contentHash: `content-${index}`,
        keywordsHash: keywords.join('|'),
        updatedAt: 1_700_000_000_000 + index,
        keywords,
        vector: createVector(options.dimension, random)
    }
}

export const createQueryVectors = (options, queryRandom) => {
    return Array.from({ length: options.queryCount }, () =>
        Array.from({ length: options.searchTextCount }, () =>
            createVector(options.dimension, queryRandom)
        )
    )
}

export const directorySize = async (path) => {
    const entries = await readdir(path, { withFileTypes: true })
    return (
        await Promise.all(
            entries.map(async (entry) => {
                const entryPath = resolve(path, entry.name)
                return entry.isDirectory()
                    ? directorySize(entryPath)
                    : (await stat(entryPath)).size
            })
        )
    ).reduce((total, size) => total + size, 0)
}

export const createMemorySampler = () => {
    const baselineRss = process.memoryUsage().rss
    let peakRss = baselineRss
    const sample = () => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }
    const timer = setInterval(sample, 10)
    timer.unref()
    return {
        sample,
        stop: () => {
            clearInterval(timer)
            sample()
            return { baselineRss, peakRss }
        }
    }
}

export const measureCpu = (startedAt) => {
    const usage = process.cpuUsage(startedAt)
    return {
        userMilliseconds: Number((usage.user / 1_000).toFixed(3)),
        systemMilliseconds: Number((usage.system / 1_000).toFixed(3)),
        totalMilliseconds: Number(
            ((usage.user + usage.system) / 1_000).toFixed(3)
        )
    }
}

const percentile = (sortedValues, ratio) => {
    const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1)
    return sortedValues[index]
}

const summarizeDurations = (durations) => {
    const sorted = [...durations].sort((left, right) => left - right)
    const total = sorted.reduce((sum, duration) => sum + duration, 0)
    return {
        minimum: Number(sorted[0].toFixed(3)),
        mean: Number((total / sorted.length).toFixed(3)),
        p50: Number(percentile(sorted, 0.5).toFixed(3)),
        p95: Number(percentile(sorted, 0.95).toFixed(3)),
        maximum: Number(sorted.at(-1).toFixed(3)),
        workerOccupiedTotal: Number(total.toFixed(3))
    }
}

const mergeSemanticHits = (groups, limit) => {
    const bestScores = new Map()
    for (const hits of groups) {
        for (const hit of hits) {
            const current = bestScores.get(hit.memoryId)
            if (current === undefined || hit.cosineScore > current) {
                bestScores.set(hit.memoryId, hit.cosineScore)
            }
        }
    }
    return [...bestScores]
        .map(([memoryId, cosineScore]) => ({ memoryId, cosineScore }))
        .sort(
            (left, right) =>
                right.cosineScore - left.cosineScore ||
                left.memoryId.localeCompare(right.memoryId)
        )
        .slice(0, limit)
}

const mergeHybridHits = (groups, limit) => {
    const bestHits = new Map()
    for (const hits of groups) {
        for (const hit of hits) {
            const current = bestHits.get(hit.memoryId)
            if (
                current === undefined ||
                hit.boostedScore > current.boostedScore ||
                (hit.boostedScore === current.boostedScore &&
                    hit.cosineScore > current.cosineScore)
            ) {
                bestHits.set(hit.memoryId, hit)
            }
        }
    }
    return [...bestHits.values()]
        .sort(
            (left, right) =>
                right.boostedScore - left.boostedScore ||
                left.memoryId.localeCompare(right.memoryId)
        )
        .slice(0, limit)
}

const appendFilters = (input, alias = '') => {
    const prefix = alias.length === 0 ? '' : `${alias}.`
    const conditions = [`${prefix}preset_id = $1`, `${prefix}status = $2`]
    const parameters = [input.presetId, input.status]
    if (input.types !== null) {
        conditions.push(
            `${prefix}type = ANY($${parameters.length + 1}::text[])`
        )
        parameters.push(input.types)
    }
    if (input.isConsolidated !== null) {
        conditions.push(`${prefix}is_consolidated = $${parameters.length + 1}`)
        parameters.push(input.isConsolidated)
    }
    return { conditions, parameters }
}

const countFilteredCandidates = async (database, input) => {
    const { conditions, parameters } = appendFilters(input)
    const result = await database.query(
        `SELECT COUNT(*)::text AS count
         FROM lm_index_memory
         WHERE ${conditions.join(' AND ')}`,
        parameters
    )
    return Number(result.rows[0].count)
}

const listKeywordCandidateIds = async (database, input) => {
    const { conditions, parameters } = appendFilters(input, 'm')
    parameters.push(input.keywords)
    const result = await database.query(
        `SELECT DISTINCT m.memory_id AS "memoryId"
         FROM lm_index_keywords AS k
         JOIN lm_index_memory AS m ON m.memory_id = k.memory_id
         WHERE ${conditions.join(' AND ')}
           AND k.keyword = ANY($${parameters.length}::text[])`,
        parameters
    )
    return result.rows.map((row) => row.memoryId)
}

const createWorkloadInput = (name, options, limit) => {
    const baseInput = {
        presetId: 'benchmark-preset-0',
        status: 'active',
        types: null,
        isConsolidated: null,
        limit
    }
    if (name === 'hybrid') {
        return {
            ...baseInput,
            types: ['fact', 'preference'],
            keywords: [
                'keyword-0',
                `keyword-${options.keywordVocabularySize - 1}`
            ],
            minSimilarity: 0.4
        }
    }
    if (name === 'incremental') {
        return { ...baseInput, isConsolidated: true }
    }
    return baseInput
}

export const runWorkload = async ({
    database,
    options,
    name,
    queryVectors,
    memorySampler,
    queryVectorIndexHybrid,
    queryVectorIndexKnn
}) => {
    const limit = 30
    const queryInput = createWorkloadInput(name, options, limit)
    const filteredCandidateCount = await countFilteredCandidates(
        database,
        queryInput
    )
    let keywordCandidateIds = null
    let semanticCandidateCount = null
    let semanticKeywordOverlapCount = null
    if (name === 'hybrid') {
        keywordCandidateIds = await listKeywordCandidateIds(
            database,
            queryInput
        )
        const semanticGroups = []
        for (const queryVector of queryVectors[0]) {
            semanticGroups.push(
                await queryVectorIndexKnn(database, {
                    ...queryInput,
                    vector: queryVector
                })
            )
        }
        const semanticHits = mergeSemanticHits(semanticGroups, limit)
        semanticCandidateCount = semanticHits.length
        const semanticIds = new Set(semanticHits.map((hit) => hit.memoryId))
        semanticKeywordOverlapCount = keywordCandidateIds.filter((memoryId) =>
            semanticIds.has(memoryId)
        ).length
    }

    const durations = []
    const cpuStartedAt = process.cpuUsage()
    let baselineHits = []
    for (let index = 0; index < queryVectors.length; index++) {
        const startedAt = performance.now()
        const groups = []
        for (const queryVector of queryVectors[index]) {
            if (name === 'hybrid') {
                groups.push(
                    await queryVectorIndexHybrid(database, {
                        ...queryInput,
                        vector: queryVector
                    })
                )
            } else {
                groups.push(
                    await queryVectorIndexKnn(database, {
                        ...queryInput,
                        vector: queryVector
                    })
                )
            }
        }
        const merged =
            name === 'hybrid'
                ? mergeHybridHits(groups, limit)
                : mergeSemanticHits(groups, limit)
        durations.push(performance.now() - startedAt)
        if (index === 0) {
            baselineHits = merged.map((hit) => hit.memoryId)
        }
        memorySampler.sample()
    }

    return {
        filteredCandidateCount,
        keywordCandidateCount: keywordCandidateIds?.length ?? null,
        semanticCandidateCount,
        semanticKeywordOverlapCount,
        queryCount: options.queryCount,
        searchTextCount: options.searchTextCount,
        durationMilliseconds: summarizeDurations(durations),
        cpuMilliseconds: measureCpu(cpuStartedAt),
        exactTopKMemoryIds: baselineHits
    }
}
