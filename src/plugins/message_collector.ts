import { Context, type Session } from 'koishi'
import {
    elementsToLogText,
    toMessageElements,
    type AtLabelResolver
} from '../service/transcript/message_log/element_text'
import type { ConversationLogEntryInput } from '../service/transcript/message_log/types'
import { resolveUserSpeaker } from '../service/transcript/user_speaker'
import { toNonEmptyString } from '../service/shared/utils'

/** 平台采集与首次注册补写共用，只从原始 session 元素生成日志正文。 */
export const buildSessionLogEntry = (
    session: Session,
    resolveAtLabel?: AtLabelResolver
): ConversationLogEntryInput | null => {
    const userId = toNonEmptyString(session.userId)
    if (
        userId == null ||
        userId === session.selfId ||
        session.argv?.command != null
    ) {
        return null
    }
    const content = elementsToLogText(
        toMessageElements({
            elements: session.elements,
            quote: session.quote
        }),
        resolveAtLabel
    )
    if (content.length === 0) {
        return null
    }
    return {
        messageId: toNonEmptyString(session.messageId) ?? undefined,
        userId,
        // 只采信用户昵称，群名片不参与日志说话人标签。
        name: toNonEmptyString(session.event?.user?.name) ?? userId,
        content,
        timestamp: session.event?.timestamp ?? Date.now(),
        role: 'user',
        origin: 'live'
    }
}

/** Character 平台采集：作用域由接入层解析，正文与入账保持同步。 */
export function apply(
    ctx: Context,
    collect: (session: Session, entry: ConversationLogEntryInput) => void,
    accepts: (session: Session) => boolean
) {
    // at 目标昵称缓存：命中才渲染昵称，未命中先记 @id 并后台预热。采集
    // 与渲染保持同步——任何微任务让出都会让后到的消息越序入账（seq 按
    // 到达分配，召回边界与提取段归属都依赖它）。缓存键含平台，与说话人
    // 解析同形。
    const atLabels = new Map<string, string>()
    const atLabelInflight = new Set<string>()

    ctx.middleware((session, next) => {
        if (accepts(session)) {
            const entry = buildSessionLogEntry(session, (targetId) => {
                const key = `${session.platform}\u0000${targetId}`
                const cached = atLabels.get(key)
                if (cached != null) {
                    return cached
                }
                if (!atLabelInflight.has(key)) {
                    atLabelInflight.add(key)
                    void resolveUserSpeaker(session, targetId)
                        .then((speaker) => {
                            atLabels.set(key, speaker.speakerLabel)
                        })
                        .catch(() => {
                            // 查询失败静默退 @id，下次出现时重试
                        })
                        .finally(() => {
                            atLabelInflight.delete(key)
                        })
                }
                return null
            })
            if (entry != null) {
                collect(session, entry)
            }
        }

        return next()
    }, true)
}
