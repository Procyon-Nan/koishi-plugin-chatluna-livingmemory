export const isModelConfigured = (model: unknown): model is string => {
    if (typeof model !== 'string') {
        return false
    }
    const trimmed = model.trim()
    return trimmed.length > 0 && trimmed !== '无'
}

/**
 * 读取非空字符串：去除首尾空白；空白字符串或非字符串输入返回 undefined。
 */
export const toNonEmptyString = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined
}

export const summarizeError = (error: unknown) => {
    if (error instanceof Error) {
        return error.stack ?? error.message
    }

    if (typeof error === 'string') {
        return error
    }

    return JSON.stringify(error)
}

export const toError = (error: unknown) => {
    if (error instanceof Error) {
        return error
    }
    return new Error(String(error))
}

export const stringifyModelContent = (content: unknown) => {
    if (typeof content === 'string') {
        return content
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (
                    part != null &&
                    typeof part === 'object' &&
                    (part as Record<string, unknown>).type === 'text' &&
                    typeof (part as Record<string, unknown>).text === 'string'
                ) {
                    return (part as { text: string }).text
                }

                return ''
            })
            .join('')
    }

    return JSON.stringify(content) ?? ''
}

export const formatDateOnly = (value: Date | string | number) => {
    const date = new Date(value)
    if (!Number.isFinite(+date)) {
        return '未知日期'
    }

    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-')
}

export const cosineSimilarity = (left: number[], right: number[]) => {
    if (
        left.length === 0 ||
        right.length === 0 ||
        left.length !== right.length
    ) {
        return 0
    }

    let dot = 0
    let leftNorm = 0
    let rightNorm = 0

    for (let index = 0; index < left.length; index++) {
        dot += left[index] * right[index]
        leftNorm += left[index] * left[index]
        rightNorm += right[index] * right[index]
    }

    if (leftNorm === 0 || rightNorm === 0) {
        return 0
    }

    return dot / Math.sqrt(leftNorm * rightNorm)
}
