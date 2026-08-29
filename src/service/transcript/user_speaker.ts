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
    const cached = cache?.get(speakerId)
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
    cache?.set(speakerId, pending)
    return pending
}
