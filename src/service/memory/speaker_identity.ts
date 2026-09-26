import { createHash } from 'crypto'
import type { MemoryScope } from '../../contracts/memory'

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

/**
 * 注册表缺行时的兜底标签：日志与提取窗口都不携带原始身份，无法反查昵称，
 * 只能以键前缀合成；该用户下次直接对话时 reconcile 会升级为真昵称。
 */
export const createSyntheticSpeakerLabel = (speakerKey: string): string =>
    `user:${speakerKey.slice(0, 8)}`

/** 调用方未显式给键时按 scope 身份推导默认关联键，应用层注册与仓储落库共用。 */
export const resolveScopeSpeakerKeys = (scope: MemoryScope): string[] => {
    const platform = scope.platform?.trim()
    const speakerId = (scope.speakerId ?? scope.userId)?.trim()
    return platform && speakerId
        ? [createUserProfileSpeakerKey(platform, speakerId)]
        : []
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

export const resolveSpeakerKeysByLabels = (
    speakerLabels: readonly string[],
    speakers: readonly {
        speakerKey: string
        speakerLabel: string
        speakerAliases?: string[]
    }[]
) => {
    const speakerKeyByLabel = new Map<string, string>()
    for (const speaker of speakers) {
        for (const label of [
            speaker.speakerLabel,
            ...(speaker.speakerAliases ?? [])
        ]) {
            speakerKeyByLabel.set(
                normalizeUserProfileSpeakerAliasKey(label),
                speaker.speakerKey
            )
        }
    }

    return normalizeSpeakerKeys(
        speakerLabels.map((label) => {
            const speakerKey = speakerKeyByLabel.get(
                normalizeUserProfileSpeakerAliasKey(label)
            )
            if (speakerKey == null) {
                throw new Error(`unknown speaker label: ${label}`)
            }
            return speakerKey
        })
    )
}
