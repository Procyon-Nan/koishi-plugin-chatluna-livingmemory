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
            content: session.content,
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

/**
 * 平台消息采集（通道 1）：appended middleware，只对已注册会话绑定的
 * channel 生效，未注册渠道零成本。刻意不复刻 Character 的关键词/白名单/
 * 静音过滤——那些只决定 Character 何时应答，不应决定记忆能看到什么。
 * 自身 bot 消息一律跳过（回复经通道 2 写入，保住交换语义关联）。
 */
export function apply(ctx: Context) {
    const registry = ctx.chatluna_living_memory.messageLog
    // at 目标昵称缓存：命中才渲染昵称，未命中先记 @id 并后台预热。采集
    // 与渲染保持同步——任何微任务让出都会让后到的消息越序入账（seq 按
    // 到达分配，召回边界与提取段归属都依赖它）。缓存键含平台，与说话人
    // 解析同形。
    const atLabels = new Map<string, string>()
    const atLabelInflight = new Set<string>()

    ctx.middleware((session, next) => {
        const conversationIds = registry.conversationIdsByChannel(
            session.platform,
            session.channelId ?? ''
        )
        if (conversationIds.length > 0) {
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
                registry.appendLive(conversationIds, entry)
            }
        }

        return next()
    })
}
