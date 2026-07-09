import { createHash } from 'crypto'
import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryMutationInput,
    PresetSpeakerRecord,
    UserProfileRecord
} from '../../types'
import { normalizeMemorySourceOrigins } from '../memory/origins/source_origins'

export const keywordFingerprintSeparator = '\u0000'

export const normalizeKeywords = (keywords: string[] | null | undefined) => {
    return keywords?.length ? keywords.slice(0, 12) : []
}

export const normalizeSentiment = (sentiment: string | null | undefined) => {
    const normalized = sentiment?.trim()
    return normalized?.length ? normalized : null
}

export const normalizeImportance = (
    importance: number | string | null | undefined
) => {
    let normalized = Number.NaN

    if (typeof importance === 'number') {
        normalized = importance
    } else if (typeof importance === 'string') {
        const trimmed = importance.trim()
        if (trimmed.length > 0) {
            normalized = Number(trimmed)
        }
    }

    if (!Number.isFinite(normalized)) {
        return null
    }

    return Math.min(1, Math.max(0, normalized))
}

export const normalizeStatus = (
    status: MemoryEntryStatus | string | null | undefined
): MemoryEntryStatus => {
    return status === 'archived' ? 'archived' : 'active'
}

export const resolveKeywords = (
    current: Pick<MemoryEntryRecord, 'keywords'>,
    patch: Partial<MemoryMutationInput>
) => {
    if (patch.keywords !== undefined) {
        return normalizeKeywords(patch.keywords)
    }

    return current.keywords
}

export const normalizeEntryRecord = (
    record: MemoryEntryRecord
): MemoryEntryRecord => ({
    ...record,
    status: normalizeStatus(record.status),
    sentiment: normalizeSentiment(record.sentiment),
    importance: normalizeImportance(record.importance),
    sourceOrigins: normalizeMemorySourceOrigins(
        (record as { sourceOrigins?: unknown }).sourceOrigins
    ),
    embedding: Array.isArray(record.embedding) ? record.embedding : null,
    embeddingModelId:
        typeof record.embeddingModelId === 'string' &&
        record.embeddingModelId.length > 0
            ? record.embeddingModelId
            : null
})

export const normalizeUserProfileRecord = (
    record: UserProfileRecord
): UserProfileRecord => ({
    ...record,
    speakerKey: record.speakerKey.trim(),
    speakerLabel: record.speakerLabel.trim(),
    content: record.content.trim(),
    sourceMemoryIds: Array.isArray(record.sourceMemoryIds)
        ? record.sourceMemoryIds.filter(
              (id): id is string => typeof id === 'string' && id.length > 0
          )
        : []
})

export const normalizeOptionalString = (value: string | null | undefined) => {
    const normalized = value?.trim()
    return normalized?.length ? normalized : null
}

export const createPresetSpeakerId = (presetId: string, speakerKey: string) => {
    return createHash('sha256')
        .update(`${presetId}\u0000${speakerKey}`)
        .digest('hex')
}

export const normalizePresetSpeakerRecord = (
    record: PresetSpeakerRecord
): PresetSpeakerRecord => ({
    ...record,
    speakerKey: record.speakerKey.trim(),
    speakerLabel: record.speakerLabel.trim(),
    speakerId: normalizeOptionalString(record.speakerId)
})
