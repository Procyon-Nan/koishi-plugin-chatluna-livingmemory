export const toPgVector = (vector: Float32Array) =>
    `[${Array.from(vector, (value) => String(value)).join(',')}]`

export const decodeVector = (value: string) =>
    new Float32Array(JSON.parse(value) as number[])

export const normalizeIndexKeywords = (keywords: string[]) => {
    const normalized = new Set<string>()
    for (const keyword of keywords) {
        const value = keyword.trim().toLowerCase()
        if (value.length > 0) normalized.add(value)
    }
    return [...normalized]
}
