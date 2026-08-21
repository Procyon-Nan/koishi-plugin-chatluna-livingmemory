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
