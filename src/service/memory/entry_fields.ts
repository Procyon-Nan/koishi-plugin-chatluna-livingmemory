export const MAX_MEMORY_KEYWORDS = 12
export const DEFAULT_MEMORY_IMPORTANCE = 0.5

export const normalizeMemoryText = (value: string) => value.trim()

export const normalizeOptionalMemoryText = (value: string | null | undefined) =>
    value?.trim() || null

export const normalizeMemoryKeywords = (
    value: readonly string[] = []
): string[] => {
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

export const normalizeMemoryImportance = (
    value: number | null | undefined
): number | null => (value == null ? null : Math.min(1, Math.max(0, value)))
