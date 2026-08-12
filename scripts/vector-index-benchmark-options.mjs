const workloadNames = ['semantic', 'hybrid', 'incremental']
const memoryTypes = ['fact', 'preference', 'context', 'plan']
const defaultOptions = {
    memoryCount: 5_000,
    dimension: 1_536,
    queryCount: 100,
    presetCount: 8,
    activeRatio: 0.8,
    consolidatedRatio: 0.7,
    memoryTypeDistribution: 'fact:1,preference:1,context:1,plan:1',
    keywordVocabularySize: 100,
    keywordHotRatio: 0.8,
    searchTextCount: 1,
    workload: 'all',
    seed: 0x6d2b79f5,
    analyze: false
}
const optionNames = {
    'memory-count': 'memoryCount',
    dimension: 'dimension',
    'query-count': 'queryCount',
    'preset-count': 'presetCount',
    'active-ratio': 'activeRatio',
    'consolidated-ratio': 'consolidatedRatio',
    'memory-type-distribution': 'memoryTypeDistribution',
    'keyword-vocabulary-size': 'keywordVocabularySize',
    'keyword-hot-ratio': 'keywordHotRatio',
    'search-text-count': 'searchTextCount',
    workload: 'workload',
    seed: 'seed',
    analyze: 'analyze'
}
const positionalOptionNames = ['memoryCount', 'dimension', 'queryCount']

const parseBoolean = (value, name) => {
    if (value === 'true') {
        return true
    }
    if (value === 'false') {
        return false
    }
    throw new Error(`invalid boolean option --${name}: ${value}`)
}

const parseNumber = (value, name) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        throw new Error(`invalid numeric option --${name}: ${value}`)
    }
    return parsed
}

const parseOptions = (args) => {
    const options = { ...defaultOptions }
    let positionalIndex = 0
    for (const argument of args) {
        if (!argument.startsWith('--')) {
            const name = positionalOptionNames[positionalIndex]
            if (name === undefined) {
                throw new Error(`unexpected positional argument: ${argument}`)
            }
            options[name] = parseNumber(argument, name)
            positionalIndex++
            continue
        }

        const separator = argument.indexOf('=')
        if (separator < 0) {
            throw new Error(`option must use --name=value syntax: ${argument}`)
        }
        const externalName = argument.slice(2, separator)
        const name = optionNames[externalName]
        if (name === undefined) {
            throw new Error(`unknown option: --${externalName}`)
        }
        const value = argument.slice(separator + 1)
        if (name === 'workload' || name === 'memoryTypeDistribution') {
            options[name] = value
        } else if (name === 'analyze') {
            options[name] = parseBoolean(value, externalName)
        } else {
            options[name] = parseNumber(value, externalName)
        }
    }
    return options
}

const assertInteger = (value, name, minimum, maximum = Infinity) => {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(
            `${name} must be an integer between ${minimum} and ${maximum}`
        )
    }
}

const assertRatio = (value, name) => {
    if (value < 0 || value > 1) {
        throw new Error(`${name} must be between 0 and 1`)
    }
}

const parseMemoryTypeDistribution = (value) => {
    const weights = new Map()
    for (const item of value.split(',')) {
        const [type, rawWeight, ...extra] = item.split(':')
        if (
            extra.length > 0 ||
            !memoryTypes.includes(type) ||
            weights.has(type)
        ) {
            throw new Error(`invalid memoryTypeDistribution item: ${item}`)
        }
        const weight = Number(rawWeight)
        if (!Number.isFinite(weight) || weight < 0) {
            throw new Error(`invalid memory type weight: ${item}`)
        }
        weights.set(type, weight)
    }
    const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0)
    if (weights.size === 0 || total <= 0) {
        throw new Error('memoryTypeDistribution must have a positive weight')
    }
    let cumulative = 0
    return [...weights].map(([type, weight], index, entries) => {
        cumulative += weight / total
        return {
            type,
            maximum: index === entries.length - 1 ? 1 : cumulative
        }
    })
}

const validateOptions = (options) => {
    assertInteger(options.memoryCount, 'memoryCount', 1)
    assertInteger(options.dimension, 'dimension', 1)
    assertInteger(options.queryCount, 'queryCount', 1)
    assertInteger(options.presetCount, 'presetCount', 1, options.memoryCount)
    assertInteger(options.keywordVocabularySize, 'keywordVocabularySize', 2)
    assertInteger(options.searchTextCount, 'searchTextCount', 1, 3)
    assertInteger(options.seed, 'seed', 0, 0xffffffff)
    assertRatio(options.activeRatio, 'activeRatio')
    assertRatio(options.consolidatedRatio, 'consolidatedRatio')
    assertRatio(options.keywordHotRatio, 'keywordHotRatio')
    parseMemoryTypeDistribution(options.memoryTypeDistribution)
    if (
        options.workload !== 'all' &&
        !workloadNames.includes(options.workload)
    ) {
        throw new Error(
            `workload must be one of all, ${workloadNames.join(', ')}`
        )
    }
}

export const createBenchmarkConfiguration = (args) => {
    const options = parseOptions(args)
    validateOptions(options)
    return {
        options,
        selectedWorkloads:
            options.workload === 'all' ? workloadNames : [options.workload],
        memoryTypeDistribution: parseMemoryTypeDistribution(
            options.memoryTypeDistribution
        )
    }
}
