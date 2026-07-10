import type { MemoryEntryStatus } from '../../contracts/memory'

export const MAX_MEMORY_KEYWORDS = 12
export const DEFAULT_MEMORY_IMPORTANCE = 0.5

export const normalizeMemoryText = (value: unknown) => {
    return typeof value === 'string' ? value.trim() : ''
}

export const normalizeOptionalMemoryText = (value: unknown) => {
    const normalized = normalizeMemoryText(value)
    return normalized.length > 0 ? normalized : null
}

export const normalizeMemoryKeywords = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
        return []
    }

    const keywords: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
        const keyword = normalizeMemoryText(item)
        if (keyword.length === 0 || seen.has(keyword)) {
            continue
        }

        keywords.push(keyword)
        seen.add(keyword)
        if (keywords.length === MAX_MEMORY_KEYWORDS) {
            break
        }
    }

    return keywords
}

export const normalizeMemoryImportance = (value: unknown): number | null => {
    const importance =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim().length > 0
              ? Number(value.trim())
              : Number.NaN

    if (!Number.isFinite(importance)) {
        return null
    }

    return Math.min(1, Math.max(0, importance))
}

export const normalizeMemoryStatus = (value: unknown): MemoryEntryStatus => {
    return value === 'archived' ? 'archived' : 'active'
}
