import { Context } from 'koishi'
import { toNonEmptyString } from '../service/shared/utils'

/**
 * 平台消息采集（通道 1）：appended middleware，只对已注册会话绑定的
 * channel 生效，未注册渠道零成本。刻意不复刻 Character 的关键词/白名单/
 * 静音过滤——那些只决定 Character 何时应答，不应决定记忆能看到什么。
 * 自身 bot 消息一律跳过（回复经通道 2 写入，保住交换语义关联）。
 */
export function apply(ctx: Context) {
    const registry = ctx.chatluna_living_memory.messageLog

    ctx.middleware((session, next) => {
        const conversationIds = registry.conversationIdsByChannel(
            session.platform,
            session.channelId ?? ''
        )
        if (conversationIds.length > 0) {
            const content = session.content?.trim()
            const isSelfMessage = session.userId === session.selfId
            const isCommand = session.argv?.command != null
            const userId = toNonEmptyString(session.userId)
            if (
                !isSelfMessage &&
                !isCommand &&
                userId != null &&
                content != null &&
                content.length > 0
            ) {
                registry.appendLive(conversationIds, {
                    messageId: toNonEmptyString(session.messageId) ?? undefined,
                    userId,
                    // 说话人标签只取用户昵称（event.user.name）。author getter
                    // 会用 member 覆盖 user、session.username 优先返回群名片，
                    // 都不可信。
                    name: toNonEmptyString(session.event?.user?.name) ?? userId,
                    content,
                    timestamp: session.event?.timestamp ?? Date.now(),
                    role: 'user',
                    origin: 'live'
                })
            }
        }

        return next()
    })
}
