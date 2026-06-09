import type { DreamOperation } from './types'

interface DreamJsonResult {
    value: unknown
    // JSON 解析失败的原因。为 null 表示解析成功（含合法但无可用操作的情形）。
    parseError: string | null
}

const parseDreamJson = (output: string): DreamJsonResult => {
    const normalized = output.trim()
    const objectStart = normalized.indexOf('{')
    const objectEnd = normalized.lastIndexOf('}')
    const arrayStart = normalized.indexOf('[')
    const arrayEnd = normalized.lastIndexOf(']')

    const useObject =
        objectStart >= 0 &&
        objectEnd > objectStart &&
        (arrayStart < 0 || objectStart < arrayStart)

    const raw = useObject
        ? normalized.slice(objectStart, objectEnd + 1)
        : arrayStart >= 0 && arrayEnd > arrayStart
          ? normalized.slice(arrayStart, arrayEnd + 1)
          : ''

    if (raw.length === 0) {
        return { value: null, parseError: 'no JSON delimiters found' }
    }

    try {
        return { value: JSON.parse(raw), parseError: null }
    } catch (error) {
        return {
            value: null,
            parseError: error instanceof Error ? error.message : String(error)
        }
    }
}

export interface ParsedDreamOperations {
    operations: DreamOperation[]
    // 模型输出无法解析为合法 JSON 时的原因，用于区分“无可用操作”与“解析失败”。
    parseError: string | null
}

export const parseDreamOperations = (output: string): ParsedDreamOperations => {
    const { value: parsed, parseError } = parseDreamJson(output)
    const rawOperations = Array.isArray(parsed)
        ? parsed
        : parsed != null &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as Record<string, unknown>).operations)
          ? (parsed as { operations: unknown[] }).operations
          : []

    const operations = rawOperations
        .map((operation): DreamOperation | null => {
            if (operation == null || typeof operation !== 'object') {
                return null
            }

            const record = operation as Record<string, unknown>
            if (
                record.action !== 'keep' &&
                record.action !== 'merge' &&
                record.action !== 'update' &&
                record.action !== 'archive' &&
                record.action !== 'deleteSource'
            ) {
                return null
            }

            return record as unknown as DreamOperation
        })
        .filter((operation): operation is DreamOperation => operation != null)

    return { operations, parseError }
}
