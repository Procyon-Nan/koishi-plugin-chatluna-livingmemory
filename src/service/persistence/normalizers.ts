import { createHash } from 'crypto'
import type {
    MemoryEntryRecord,
    PresetSpeakerRecord,
    UserProfileRecord
} from '../../contracts/memory'
import type {
    LivingMemoryEntrySpeakerRecord,
    PresetSpeakerTableRecord
} from './types'
import {
    normalizeMemoryImportance,
    normalizeOptionalMemoryText
} from '../memory/entry_fields'
import { normalizeSpeakerKeys } from '../memory/speaker_identity'

// 空串与 null 都归一为「无会话归属、全局可见」；历史 WebUI 伪会话键（webui: 前缀）
// 已由启动迁移 webui-source-conversation-cleanup-v1 写回 null，此处不再折叠。
export const normalizeSourceConversationId = (value: string | null) => {
    const normalized = value?.trim()
    if (normalized == null || normalized.length === 0) {
        return null
    }
    return normalized
}

export const normalizeEntryRecord = (
    record: MemoryEntryRecord
): MemoryEntryRecord => ({
    ...record,
    speakerKeys: normalizeSpeakerKeys(record.speakerKeys),
    summary: normalizeOptionalMemoryText(record.summary),
    sentiment: normalizeOptionalMemoryText(record.sentiment),
    importance: normalizeMemoryImportance(record.importance),
    sourceConversationId: normalizeSourceConversationId(
        record.sourceConversationId
    ),
    sourceLabel: normalizeOptionalMemoryText(record.sourceLabel)
})

export const normalizeUserProfileRecord = (
    record: UserProfileRecord
): UserProfileRecord => ({
    ...record,
    speakerKey: record.speakerKey.trim(),
    speakerLabel: record.speakerLabel.trim(),
    content: record.content.trim()
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

export const createActiveMemorySpeakerRows = (
    entry: Pick<MemoryEntryRecord, 'id' | 'presetId' | 'speakerKeys' | 'status'>
): LivingMemoryEntrySpeakerRecord[] => {
    if (entry.status !== 'active') {
        return []
    }

    return normalizeSpeakerKeys(entry.speakerKeys).map((speakerKey) => ({
        id: createHash('sha256')
            .update(`${entry.id}\u0000${speakerKey}`)
            .digest('hex'),
        presetId: entry.presetId,
        speakerKey,
        memoryId: entry.id
    }))
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
    record: PresetSpeakerTableRecord
): PresetSpeakerRecord => {
    const aliases = record.speakerAliases ?? [record.speakerLabel]
    const speakerAliases = aliases
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0)
    return {
        ...record,
        speakerKey: record.speakerKey.trim(),
        speakerLabel: record.speakerLabel.trim(),
        speakerAliases: [...new Set(speakerAliases)],
        speakerId: normalizeOptionalString(record.speakerId),
        platform: normalizeOptionalString(record.platform)
    }
}
