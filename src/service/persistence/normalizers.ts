import { createHash } from 'crypto'
import type {
    MemoryEntryRecord,
    PresetSpeakerRecord,
    UserProfileRecord
} from '../../contracts/memory'
import {
    normalizeMemoryImportance,
    normalizeMemoryStatus,
    normalizeOptionalMemoryText
} from '../memory/entry_fields'
import { normalizeMemorySourceOrigins } from '../memory/origins/source_origins'

export const normalizeEntryRecord = (
    record: MemoryEntryRecord
): MemoryEntryRecord => ({
    ...record,
    status: normalizeMemoryStatus(record.status),
    sentiment: normalizeOptionalMemoryText(record.sentiment),
    importance: normalizeMemoryImportance(record.importance),
    sourceOrigins: normalizeMemorySourceOrigins(
        (record as { sourceOrigins?: unknown }).sourceOrigins
    ),
    embedding: Array.isArray(record.embedding) ? record.embedding : null,
    embeddingModelId:
        typeof record.embeddingModelId === 'string' &&
        record.embeddingModelId.length > 0
            ? record.embeddingModelId
            : null,
    isConsolidated: record.isConsolidated === true
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

export const createPresetImportId = (
    recordType: 'entry' | 'user-profile',
    presetId: string,
    sourceId: string
) => {
    return createHash('sha256')
        .update(`import\u0000${recordType}\u0000${presetId}\u0000${sourceId}`)
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
