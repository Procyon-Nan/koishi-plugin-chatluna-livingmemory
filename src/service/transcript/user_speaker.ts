import type { Session } from 'koishi'
import { createUserProfileSpeakerKey } from '../memory/speaker_identity'
import { toNonEmptyString } from '../shared/utils'

export type UserSpeakerCache = Map<string, Promise<ResolvedUserSpeaker>>

interface ResolvedUserSpeaker {
    speakerKey: string
    speakerLabel: string
}

export const resolveUserSpeaker = async (
    session: Session,
    userId: string,
    cache?: UserSpeakerCache
): Promise<ResolvedUserSpeaker> => {
    const speakerId = userId.trim()
    // 缓存键必须包含平台：同一 userId 在不同平台对应不同 speakerKey。
    const cacheKey = `${session.platform}\u0000${speakerId}`
    const cached = cache?.get(cacheKey)
    if (cached != null) {
        return cached
    }

    const pending = (async () => {
        const speakerLabel = toNonEmptyString(
            (await session.bot.getUser(speakerId)).name
        )
        if (speakerLabel == null) {
            throw new Error(`global user name is missing: ${speakerId}`)
        }

        return {
            speakerKey: createUserProfileSpeakerKey(
                session.platform,
                speakerId
            ),
            speakerLabel
        }
    })()
    // 解析失败的条目不留在缓存中，平台 API 瞬时故障在下一轮重试。
    pending.catch(() => cache?.delete(cacheKey))
    cache?.set(cacheKey, pending)
    return pending
}
