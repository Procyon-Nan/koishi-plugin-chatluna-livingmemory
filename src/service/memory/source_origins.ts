import type {
    MemoryEntryRecord,
    MemorySourceMessage,
    MemorySourceOrigin
} from '../../types'

const cloneStringArray = (value: string[] | undefined) =>
    Array.isArray(value) ? [...value] : undefined

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value != null && !Array.isArray(value)
}

const readOptionalStringArray = (
    source: Record<string, unknown>,
    fieldName: string
) => {
    const value = source[fieldName]
    if (value == null) {
        return undefined
    }
    if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string')
    ) {
        throw new Error(`sourceOrigins message ${fieldName} must be string[].`)
    }

    return [...value]
}

const normalizeSourceMessage = (value: unknown): MemorySourceMessage => {
    if (!isRecord(value)) {
        throw new Error('sourceOrigins message must be an object.')
    }
    if (
        value.role !== 'user' &&
        value.role !== 'assistant' &&
        value.role !== 'system'
    ) {
        throw new Error('sourceOrigins message role is invalid.')
    }
    if (typeof value.content !== 'string') {
        throw new Error('sourceOrigins message content must be a string.')
    }
    if (value.speakerLabel != null && typeof value.speakerLabel !== 'string') {
        throw new Error('sourceOrigins message speakerLabel must be a string.')
    }
    if (value.createdAt != null && typeof value.createdAt !== 'string') {
        throw new Error('sourceOrigins message createdAt must be a string.')
    }

    const speakerLabel =
        typeof value.speakerLabel === 'string' ? value.speakerLabel : undefined
    const createdAt =
        typeof value.createdAt === 'string' ? value.createdAt : undefined
    const contentLines = readOptionalStringArray(value, 'contentLines')
    const transcriptLines = readOptionalStringArray(value, 'transcriptLines')

    return {
        role: value.role,
        ...(speakerLabel == null ? {} : { speakerLabel }),
        ...(contentLines == null ? {} : { contentLines }),
        ...(createdAt == null ? {} : { createdAt }),
        ...(transcriptLines == null ? {} : { transcriptLines }),
        content: value.content
    }
}

export const cloneSourceMessage = (
    message: MemorySourceMessage
): MemorySourceMessage => ({
    role: message.role,
    ...(message.speakerLabel == null
        ? {}
        : { speakerLabel: message.speakerLabel }),
    ...(message.contentLines == null
        ? {}
        : { contentLines: cloneStringArray(message.contentLines) }),
    ...(message.createdAt == null ? {} : { createdAt: message.createdAt }),
    ...(message.transcriptLines == null
        ? {}
        : { transcriptLines: cloneStringArray(message.transcriptLines) }),
    content: message.content
})

export const createSourceOriginsFromMessages = (
    messages: MemorySourceMessage[]
): MemorySourceOrigin[] => {
    return messages.length > 0
        ? [
              {
                  messages: messages.map(cloneSourceMessage)
              }
          ]
        : []
}

const fingerprintSourceOrigin = (origin: MemorySourceOrigin) => {
    return JSON.stringify(
        origin.messages.map((message) => ({
            role: message.role,
            speakerLabel: message.speakerLabel ?? '',
            createdAt: message.createdAt ?? '',
            contentLines: message.contentLines ?? [],
            content: message.content
        }))
    )
}

export const mergeMemorySourceOrigins = (
    entries: Pick<MemoryEntryRecord, 'sourceOrigins'>[]
): MemorySourceOrigin[] => {
    const seen = new Set<string>()
    const merged: MemorySourceOrigin[] = []

    for (const entry of entries) {
        for (const origin of entry.sourceOrigins) {
            const fingerprint = fingerprintSourceOrigin(origin)
            if (seen.has(fingerprint)) {
                continue
            }

            seen.add(fingerprint)
            merged.push({
                messages: origin.messages.map(cloneSourceMessage)
            })
        }
    }

    return merged
}

export const normalizeMemorySourceOrigins = (
    value: unknown
): MemorySourceOrigin[] => {
    if (value == null) {
        return []
    }
    if (!Array.isArray(value)) {
        throw new Error('sourceOrigins must be an array.')
    }

    return value.map((origin) => {
        if (!isRecord(origin)) {
            throw new Error('sourceOrigins item must be an object.')
        }
        if (!Array.isArray(origin.messages)) {
            throw new Error('sourceOrigins item messages must be an array.')
        }

        return {
            messages: origin.messages.map(normalizeSourceMessage)
        }
    })
}
