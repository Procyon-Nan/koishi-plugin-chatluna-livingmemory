import type { LivingMemoryTranscriptMessage } from '../../contracts/memory'
import { toNonEmptyString } from '../shared/utils'

export type LivingMemoryMessageTimeValue = Date | number | string

export interface LivingMemoryTranscriptInput {
    role: LivingMemoryTranscriptMessage['role']
    speakerKey?: string
    speakerLabel: string
    content: string | string[]
    createdAt: unknown
    stripSpeakerPrefix?: boolean
}

export type LivingMemoryTranscriptMessageInvalidReason =
    'missing-created-at' | 'missing-speaker' | 'empty-content'

export interface LivingMemoryTranscriptMessageInvalidResult {
    message: null
    reason: LivingMemoryTranscriptMessageInvalidReason
}

export interface LivingMemoryTranscriptMessageValidResult {
    message: LivingMemoryTranscriptMessage
    reason: null
}

export type LivingMemoryTranscriptMessageResult =
    | LivingMemoryTranscriptMessageInvalidResult
    | LivingMemoryTranscriptMessageValidResult

const bracketSpeakerLinePattern = /^\[([^\]]+)\]\s*说\s*[:：]\s*(.*)$/u
const bareSpeakerLinePattern =
    /^([^\s:：\[\]，。！？,.!?]{1,64})\s*说\s*[:：]\s*(.*)$/u

const normalizeBracketSpeaker = (speaker: string) => {
    const parts = speaker
        .split(/[,，]/u)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    return parts[parts.length - 1] ?? speaker.trim()
}

/**
 * 解析「昵称说：内容」格式的话前行（含方括号变体），
 * 用于从转写文本中识别并剥离说话者前缀；不匹配时返回 null。
 */
export const parseLivingMemorySpeakerLine = (line: string) => {
    const bracketMatched = line.match(bracketSpeakerLinePattern)
    if (bracketMatched != null) {
        return {
            speaker: normalizeBracketSpeaker(bracketMatched[1]),
            content: bracketMatched[2].trim()
        }
    }

    const bareMatched = line.match(bareSpeakerLinePattern)
    if (bareMatched != null) {
        return {
            speaker: bareMatched[1].trim(),
            content: bareMatched[2].trim()
        }
    }

    return null
}

export const toLivingMemoryDate = (value: unknown) => {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : null
    }

    if (typeof value === 'number') {
        const date = new Date(value)
        return Number.isFinite(date.getTime()) ? date : null
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
        return null
    }

    const normalized = value.trim()
    const timestamp = /^\d+$/u.test(normalized)
        ? Number(normalized)
        : Date.parse(normalized)
    if (!Number.isFinite(timestamp)) {
        return null
    }

    return new Date(timestamp)
}

const toContentLines = (
    content: string | string[],
    stripSpeakerPrefix: boolean
) => {
    const parts = Array.isArray(content) ? content : [content]

    return parts
        .flatMap((part) => part.replace(/\r\n/g, '\n').split('\n'))
        .map((line) => {
            const trimmed = line.trim()
            const parsed = parseLivingMemorySpeakerLine(trimmed)
            return stripSpeakerPrefix && parsed != null
                ? parsed.content
                : trimmed
        })
        .filter((line) => line.length > 0)
}

export const createLivingMemoryTranscriptMessageResult = (
    input: LivingMemoryTranscriptInput
): LivingMemoryTranscriptMessageResult => {
    const createdAt = toLivingMemoryDate(input.createdAt)
    if (createdAt == null) {
        return {
            message: null,
            reason: 'missing-created-at'
        }
    }

    const speakerLabel = toNonEmptyString(input.speakerLabel)
    if (speakerLabel == null) {
        return {
            message: null,
            reason: 'missing-speaker'
        }
    }

    const contentLines = toContentLines(
        input.content,
        input.stripSpeakerPrefix ?? true
    )
    if (contentLines.length === 0) {
        return {
            message: null,
            reason: 'empty-content'
        }
    }
    const speakerKey = toNonEmptyString(input.speakerKey)

    const message: LivingMemoryTranscriptMessage = {
        role: input.role,
        speakerLabel,
        contentLines,
        createdAt
    }
    if (speakerKey != null) {
        message.speakerKey = speakerKey
    }

    return {
        message,
        reason: null
    }
}

const padDatePart = (value: number) => value.toString().padStart(2, '0')

export const formatLivingMemoryMessageTime = (date: Date) => {
    const datePart = `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`
    const timePart = `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`

    return `${datePart} ${timePart}`
}
