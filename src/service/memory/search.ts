import type {
    LivingMemorySearchInput,
    LivingMemorySearchMemoryType,
    LivingMemorySearchResult,
    MemoryEntryRecord
} from '../../types'
import { memoryEntryTypes } from '../../types'

const searchFieldWeights = {
    keywords: 3,
    summary: 2,
    content: 1
} as const

const maxSearchTextCount = 5
const minSearchTextLength = 2
const maxSearchTextLength = 6

export const normalizeSearchText = (value: string) => {
    return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

const textLength = (value: string) => Array.from(value).length

const isMemoryEntryType = (
    value: LivingMemorySearchMemoryType
): value is MemoryEntryRecord['type'] => {
    return (memoryEntryTypes as readonly string[]).includes(value)
}

const ensureSearchTexts = (searchTexts: string[]) => {
    if (!Array.isArray(searchTexts) || searchTexts.length === 0) {
        throw new Error('searchTexts must not be empty.')
    }

    if (searchTexts.length > maxSearchTextCount) {
        throw new Error('searchTexts accepts at most 5 query phrases.')
    }

    const normalized: string[] = []
    const seen = new Set<string>()

    for (const rawText of searchTexts) {
        if (typeof rawText !== 'string') {
            throw new Error('searchTexts must contain only strings.')
        }

        const text = normalizeSearchText(rawText)
        const length = textLength(text)
        if (length < minSearchTextLength || length > maxSearchTextLength) {
            throw new Error(
                'Each searchTexts item must be 2 to 6 characters after trimming.'
            )
        }

        if (seen.has(text)) {
            continue
        }

        seen.add(text)
        normalized.push(text)
    }

    if (normalized.length === 0) {
        throw new Error('searchTexts must not be empty.')
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

const scoreSearchText = (entry: MemoryEntryRecord, searchText: string) => {
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

    return score
}

const pickSearchResult = (
    entry: MemoryEntryRecord
): LivingMemorySearchResult => ({
    id: entry.id,
    type: entry.type,
    status: entry.status,
    content: entry.content,
    keywords: [...entry.keywords],
    summary: entry.summary,
    importance: entry.importance,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
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

    const searchTexts = ensureSearchTexts(options.searchTexts)
    const memoryTypes = ensureMemoryTypes(options.memoryTypes)

    const scoredItems = items
        .filter((item) => item.status === 'active')
        .filter((item) =>
            memoryTypes == null ? true : memoryTypes.has(item.type)
        )
        .map((item) => {
            let bestScore = 0

            for (const searchText of searchTexts) {
                const score = scoreSearchText(item, searchText)
                if (score > bestScore) {
                    bestScore = score
                }
            }

            return {
                entry: item,
                relevanceScore: bestScore
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
        .map(({ entry }) => pickSearchResult(entry))
}
