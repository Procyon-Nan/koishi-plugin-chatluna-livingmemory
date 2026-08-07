export const toSqliteVector = (vector: Float32Array) => {
    return new Uint8Array(
        vector.buffer,
        vector.byteOffset,
        vector.byteLength
    )
}

export const decodeVector = (value: Uint8Array) => {
    const bytes = new Uint8Array(value.byteLength)
    bytes.set(value)
    return new Float32Array(bytes.buffer)
}

export const normalizeIndexKeywords = (keywords: string[]) => {
    const normalized = new Set<string>()
    for (const keyword of keywords) {
        const value = keyword.trim().toLowerCase()
        if (value.length > 0) {
            normalized.add(value)
        }
    }
    return [...normalized]
}

export const toSqliteBoolean = (value: boolean) => {
    return Number(value)
}

export const calculateCosine = (
    left: Float32Array,
    right: Float32Array
) => {
    if (left.length !== right.length) {
        throw new Error(
            `vector dimension mismatch: left=${left.length}, right=${right.length}`
        )
    }

    let dot = 0
    let leftNorm = 0
    let rightNorm = 0
    for (let index = 0; index < left.length; index++) {
        const leftValue = left[index]
        const rightValue = right[index]
        dot += leftValue * rightValue
        leftNorm += leftValue * leftValue
        rightNorm += rightValue * rightValue
    }

    if (leftNorm === 0 || rightNorm === 0) {
        throw new Error('cannot calculate cosine similarity for a zero vector')
    }

    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}
