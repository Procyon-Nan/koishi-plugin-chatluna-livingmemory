import { createHash } from 'crypto'

const collapseWhitespace = (value: string) => value.replace(/\s+/gu, ' ').trim()

export const normalizeUserProfileSpeakerLabel = collapseWhitespace

export const normalizeUserProfileSpeakerAliasKey = (speakerLabel: string) => {
    return collapseWhitespace(speakerLabel).toLowerCase()
}

export const createUserProfileSpeakerKey = (
    platform: string,
    speakerId: string
) => {
    return createHash('sha256')
        .update(`${platform.trim()}\u0000${speakerId.trim()}`)
        .digest('hex')
}

export const normalizeSpeakerKeys = (
    speakerKeys: readonly string[] | null | undefined
) => {
    return [
        ...new Set(
            (speakerKeys ?? [])
                .map((key) => key.trim())
                .filter((key) => key.length > 0)
        )
    ].sort()
}
