import { toNonEmptyString } from '../../shared/utils'
import type { ConversationLogEntryInput } from './types'

/** getMessageList 返回的适配消息（@satorijs/protocol Message 的本地最小镜像）。 */
export interface BackfillHistoryMessage {
    id?: string
    messageId?: string
    content?: string
    elements?: Array<{ type: string; attrs?: Record<string, unknown> }>
    user?: { id?: string; name?: string }
    timestamp?: number | string | Date
    createdAt?: number | string | Date
}

export interface ConversationBackfillBot {
    selfId: string
    /**
     * @satorijs/protocol Methods 同形方法（Bot 类型已声明）；适配器覆盖
     * 不一（OneBot 实测仅返回 data，Milky 返回 data + next 游标），
     * 故保留运行时特性检测。未实现方缺省即降级为空回填。
     */
    getMessageList?: (
        channelId: string,
        before?: string,
        direction?: 'before' | 'after' | 'around'
    ) => Promise<{
        data?: BackfillHistoryMessage[]
        prev?: string
        next?: string
    }>
}

export interface ConversationBackfillOptions {
    channelId: string
    warmupCount: number
}

const normalizeTimestamp = (value: number | string | Date | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1_000_000_000_000 ? value * 1000 : value
    }
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.getTime() : null
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

const toTextContent = (message: BackfillHistoryMessage) => {
    if (message.elements == null) {
        return toNonEmptyString(message.content)?.trim() ?? ''
    }
    return message.elements
        .filter((element) => element.type === 'text')
        .map((element) => {
            // Koishi 文本元素的正文在 attrs.content（h.text() 的产物形状）
            const text = element.attrs?.['content']
            return typeof text === 'string' ? text : ''
        })
        .join('')
        .trim()
}

/** 说话人标签只取用户昵称（user.name）；群名片（nick/member）不进模型可见视图。 */
const toDisplayName = (message: BackfillHistoryMessage, userId: string) => {
    return toNonEmptyString(message.user?.name) ?? userId
}

/**
 * 经适配器同形方法 getMessageList 拉取平台历史（分页契约镜像 Character
 * pullBot：批内时间正序，续读游标 next ?? prev ?? 批首 id——BidiList 契约
 * next 为续读方向游标，Milky 实测填 next，OneBot 实测仅返回 data）。
 * 无平台时间戳的消息直接丢弃——回填没有可靠到达时钟，宁缺勿滥，防纪元
 * 穿透。平台调用失败直接抛出，由注册表保持未预热、下次 warmup 重试；
 * 成功重拉经去重幂等。
 */
export const pullConversationBackfill = async (
    bot: ConversationBackfillBot,
    options: ConversationBackfillOptions
): Promise<ConversationLogEntryInput[]> => {
    if (typeof bot.getMessageList !== 'function') {
        return []
    }

    const results: ConversationLogEntryInput[] = []
    let nextId: string | undefined
    let prevId: string | undefined

    while (results.length < options.warmupCount) {
        const response = await bot.getMessageList(
            options.channelId,
            nextId,
            'before'
        )

        const batch = response.data ?? []
        if (batch.length < 1) {
            break
        }

        const entries: ConversationLogEntryInput[] = []
        for (const message of batch) {
            const timestamp = normalizeTimestamp(
                message.timestamp ?? message.createdAt
            )
            if (timestamp == null) {
                continue
            }
            const content = toTextContent(message)
            if (content.length === 0) {
                continue
            }
            const userId = toNonEmptyString(message.user?.id) ?? '0'
            entries.push({
                messageId:
                    toNonEmptyString(message.messageId) ??
                    toNonEmptyString(message.id) ??
                    undefined,
                userId,
                name: toDisplayName(message, userId),
                content,
                timestamp,
                role: userId === bot.selfId ? 'assistant' : 'user',
                origin: 'backfill'
            })
        }
        results.unshift(...entries)

        const oldest = batch[0]
        nextId =
            response.next ??
            response.prev ??
            toNonEmptyString(oldest?.id) ??
            toNonEmptyString(oldest?.messageId) ??
            undefined
        if (nextId == null || nextId.length < 1 || nextId === prevId) {
            break
        }
        prevId = nextId
    }

    return results
}
