import type {
    LivingMemorySearchInput,
    LivingMemorySearchMemoryType,
    LivingMemorySearchResult,
    MemoryEntryRecord
} from '../../types'
import { memoryEntryTypes } from '../../types'
import type { MemorySearchTextRule } from './search_contract'
import {
    broadSearchTextRule,
    countSearchTextCharacters,
    formatSearchTextLengthError,
    memorySearchMaxTextCount,
    normalizeSearchText,
    specificSearchTextRule
} from './search_contract'

const searchFieldWeights = {
    keywords: 3,
    summary: 2,
    content: 1
} as const

const queryTypeWeights = {
    broad: 1,
    specific: 2
} as const

const specificSearchTextMatchBonus = 2
const multiSearchTextMatchBonus = 1

const isMemoryEntryType = (
    value: LivingMemorySearchMemoryType
): value is MemoryEntryRecord['type'] => {
    return (memoryEntryTypes as readonly string[]).includes(value)
}

const ensureSearchTexts = (
    rule: MemorySearchTextRule,
    searchTexts: string[],
    options: { allowEmpty?: boolean } = {}
) => {
    if (!Array.isArray(searchTexts) || searchTexts.length === 0) {
        if (options.allowEmpty === true) {
            return []
        }

        throw new Error(`${rule.fieldName} must not be empty.`)
    }

    if (searchTexts.length > memorySearchMaxTextCount) {
        throw new Error(
            `${rule.fieldName} accepts at most ${memorySearchMaxTextCount} query phrases.`
        )
    }

    const normalized: string[] = []
    const seen = new Set<string>()

    for (const rawText of searchTexts) {
        if (typeof rawText !== 'string') {
            throw new Error(`${rule.fieldName} must contain only strings.`)
        }

        const length = countSearchTextCharacters(rawText)
        if (length < rule.minLength || length > rule.maxLength) {
            throw new Error(formatSearchTextLengthError(rule))
        }
        const text = normalizeSearchText(rawText)

        if (seen.has(text)) {
            continue
        }

        seen.add(text)
        normalized.push(text)
    }

    if (normalized.length === 0) {
        throw new Error(`${rule.fieldName} must not be empty.`)
    }

    return normalized
}

const ensureMemoryTypes = (memoryTypes: LivingMemorySearchMemoryType[]) => {
    if (!Array.isArray(memoryTypes) || memoryTypes.length === 0) {
        throw new Error('memoryTypes must not be empty.')
    }

    if (memoryTypes.includes('all')) {
        if (memoryTypes.length !== 1) {
            throw new Error('memoryTypes cannot mix all with other types.')
        }

        return null
    }

    const normalized: MemoryEntryRecord['type'][] = []
    const seen = new Set<MemoryEntryRecord['type']>()

    for (const rawType of memoryTypes) {
        if (!isMemoryEntryType(rawType)) {
            throw new Error(`Unsupported memoryTypes value: ${String(rawType)}`)
        }

        if (seen.has(rawType)) {
            continue
        }

        seen.add(rawType)
        normalized.push(rawType)
    }

    return new Set(normalized)
}

const normalizeImportance = (value: number | null): number => {
    return value ?? Number.NEGATIVE_INFINITY
}

const normalizeTimestamp = (
    entry: Pick<MemoryEntryRecord, 'createdAt' | 'updatedAt'>
) => {
    return Math.max(entry.createdAt.getTime(), entry.updatedAt.getTime())
}

const scoreSearchText = (
    entry: MemoryEntryRecord,
    searchText: string,
    queryType: keyof typeof queryTypeWeights
) => {
    let score = 0

    if (
        entry.keywords.some((keyword) =>
            normalizeSearchText(keyword).includes(searchText)
        )
    ) {
        score += searchFieldWeights.keywords
    }

    const summary = normalizeSearchText(entry.summary ?? '')
    if (summary.includes(searchText)) {
        score += searchFieldWeights.summary
    }

    const content = normalizeSearchText(entry.content)
    if (content.includes(searchText)) {
        score += searchFieldWeights.content
    }

    return score * queryTypeWeights[queryType]
}

const pickSearchResult = (
    entry: MemoryEntryRecord,
    matchedBroadSearchTexts: string[],
    matchedSpecificSearchTexts: string[]
): LivingMemorySearchResult => ({
    type: entry.type,
    content: entry.content,
    keywords: [...entry.keywords],
    summary: entry.summary,
    importance: entry.importance,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    matchedBroadSearchTexts,
    matchedSpecificSearchTexts
})

export interface LivingMemorySearchOptions extends LivingMemorySearchInput {
    maxCandidates: number
}

export function searchLivingMemoryEntries(
    items: MemoryEntryRecord[],
    options: LivingMemorySearchOptions
): LivingMemorySearchResult[] {
    if (
        !Number.isInteger(options.maxCandidates) ||
        options.maxCandidates <= 0
    ) {
        throw new Error('maxCandidates must be a positive integer.')
    }

    const broadSearchTexts = ensureSearchTexts(
        broadSearchTextRule,
        options.broadSearchTexts
    )
    const specificSearchTexts = ensureSearchTexts(
        specificSearchTextRule,
        options.specificSearchTexts ?? [],
        { allowEmpty: true }
    )
    const memoryTypes = ensureMemoryTypes(options.memoryTypes)

    const scoredItems = items
        .filter((item) => item.status === 'active')
        .filter((item) =>
            memoryTypes == null ? true : memoryTypes.has(item.type)
        )
        .map((item) => {
            let relevanceScore = 0
            let matchedSearchTextCount = 0
            const matchedBroadSearchTexts: string[] = []
            const matchedSpecificSearchTexts: string[] = []

            for (const searchText of broadSearchTexts) {
                const score = scoreSearchText(item, searchText, 'broad')
                if (score > 0) {
                    relevanceScore += score
                    matchedSearchTextCount += 1
                    matchedBroadSearchTexts.push(searchText)
                }
            }

            for (const searchText of specificSearchTexts) {
                const score = scoreSearchText(item, searchText, 'specific')
                if (score > 0) {
                    relevanceScore += score + specificSearchTextMatchBonus
                    matchedSearchTextCount += 1
                    matchedSpecificSearchTexts.push(searchText)
                }
            }

            if (matchedSearchTextCount > 1) {
                relevanceScore +=
                    (matchedSearchTextCount - 1) * multiSearchTextMatchBonus
            }

            return {
                entry: item,
                relevanceScore,
                matchedBroadSearchTexts,
                matchedSpecificSearchTexts
            }
        })
        .filter((item) => item.relevanceScore > 0)

    scoredItems.sort((left, right) => {
        if (right.relevanceScore !== left.relevanceScore) {
            return right.relevanceScore - left.relevanceScore
        }

        const rightImportance = normalizeImportance(right.entry.importance)
        const leftImportance = normalizeImportance(left.entry.importance)
        if (rightImportance !== leftImportance) {
            return rightImportance - leftImportance
        }

        return normalizeTimestamp(right.entry) - normalizeTimestamp(left.entry)
    })

    return scoredItems
        .slice(0, options.maxCandidates)
        .map(({ entry, matchedBroadSearchTexts, matchedSpecificSearchTexts }) =>
            pickSearchResult(
                entry,
                matchedBroadSearchTexts,
                matchedSpecificSearchTexts
            )
        )
}
