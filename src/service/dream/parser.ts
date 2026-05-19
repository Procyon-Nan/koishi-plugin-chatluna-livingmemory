import type { DreamOperation } from './types'

const parseDreamJson = (output: string): unknown => {
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
        return null
    }

    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

export const parseDreamOperations = (output: string): DreamOperation[] => {
    const parsed = parseDreamJson(output)
    const operations = Array.isArray(parsed)
        ? parsed
        : parsed != null &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as Record<string, unknown>).operations)
          ? (parsed as { operations: unknown[] }).operations
          : []

    return operations
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
}
