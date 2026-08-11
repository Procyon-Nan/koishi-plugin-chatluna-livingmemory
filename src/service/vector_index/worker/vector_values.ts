export const toPgVector = (vector: Float32Array) =>
    `[${Array.from(vector, (value) => String(value)).join(',')}]`

export const decodeVector = (value: unknown) => {
    if (value instanceof Float32Array)
        return new Float32Array(value) as Float32Array<ArrayBuffer>
    if (Array.isArray(value))
        return new Float32Array(value.map(Number)) as Float32Array<ArrayBuffer>
    const text = String(value)
        .trim()
        .replace(/^\[|\]$/g, '')
    return new Float32Array(
        text.length === 0 ? [] : text.split(',').map(Number)
    ) as Float32Array<ArrayBuffer>
}

export const normalizeIndexKeywords = (keywords: string[]) => {
    const normalized = new Set<string>()
    for (const keyword of keywords) {
        const value = keyword.trim().toLowerCase()
        if (value.length > 0) normalized.add(value)
    }
    return [...normalized]
}
