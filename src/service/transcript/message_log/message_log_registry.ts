import {
    pullConversationBackfill,
    type ConversationBackfillBot
} from './backfill'
import { ConversationMessageLog, messageKey } from './message_log'
import type {
    ConversationLogBinding,
    ConversationLogEntryInput,
    ConversationLogMessage
} from './types'

/** 单会话日志容量与冷启动回填预热条数（内部常量，不暴露为配置）。 */
const LOG_CAPACITY = 500
const BACKFILL_WARMUP_COUNT = 200

type RecallMessageIdentity = Pick<
    ConversationLogEntryInput,
    'messageId' | 'userId' | 'content' | 'timestamp'
>

interface ConversationLogEntry {
    binding: ConversationLogBinding
    bot?: ConversationBackfillBot
    log: ConversationMessageLog
    /** 回填进行中：实时与回复消息先入缓冲，回填结束后按序冲刷。 */
    backfilling: boolean
    /** 回填已完成（含适配器不支持而立即结束），此后写入直通。 */
    warm: boolean
    warmupPromise: Promise<void> | null
    historyEndSeq: number
    pendingAppends: ConversationLogEntryInput[]
}

export const toBackfillChannelId = (binding: ConversationLogBinding) => {
    if (!binding.isDirect) {
        return binding.channelId
    }
    // 私聊平台约定：channelId 即对方 userId；OneBot 等实现要求 private: 前缀。
    return binding.channelId.startsWith('private:')
        ? binding.channelId
        : `private:${binding.channelId}`
}

/**
 * 读取侧身份匹配与写入侧去重键同构：双方都有 messageId 时只按 ID 判定，
 * 否则退到 (userId, timestamp, content) 三元组——防止同用户同秒重复内容
 * 的不同消息互相冒充（OneBot 时间戳为秒级，确有可能）。
 */
const matchesCurrentMessage = (
    candidate: ConversationLogMessage,
    current: RecallMessageIdentity
) => {
    const currentMessageId = current.messageId
    if (
        currentMessageId != null &&
        currentMessageId.length > 0 &&
        candidate.messageId != null &&
        candidate.messageId.length > 0
    ) {
        return candidate.messageId === currentMessageId
    }
    return (
        candidate.userId === current.userId &&
        candidate.timestamp === current.timestamp &&
        candidate.content === current.content
    )
}

/** 按会话管理滚动消息日志与历史预热。 */
export class MessageLogRegistry {
    private readonly conversations = new Map<string, ConversationLogEntry>()

    register(
        conversationId: string,
        binding: ConversationLogBinding,
        bot?: ConversationBackfillBot
    ) {
        const existing = this.conversations.get(conversationId)
        if (existing != null) {
            return
        }

        const entry: ConversationLogEntry = {
            binding,
            bot,
            log: new ConversationMessageLog(LOG_CAPACITY),
            backfilling: bot != null,
            warm: bot == null,
            warmupPromise: null,
            historyEndSeq: 0,
            pendingAppends: []
        }
        this.conversations.set(conversationId, entry)

        if (bot != null) this.startBackfill(entry)
    }

    /**
     * 等待回填结束（成功、不支持或失败均算结束）；失败后下次调用重新尝试。
     * 永不 reject——回填只是历史预热，失败不应打断召回或提取。
     */
    async warmup(conversationId: string): Promise<void> {
        const entry = this.conversations.get(conversationId)
        if (entry == null || entry.warm) {
            return
        }
        if (entry.warmupPromise == null) {
            this.startBackfill(entry)
        }
        await entry.warmupPromise?.catch(() => {})
    }

    /**
     * 回填是否已成功完成（含适配器不支持而立即结束）。失败重试期间为
     * false，供提取游标初始化等待回填落地，避免重试历史越过游标。
     */
    isWarm(conversationId: string): boolean {
        return this.conversations.get(conversationId)?.warm ?? false
    }

    /** 捕获下一条实时消息之前的边界，回填完成后读取最终序号。 */
    captureCursor(conversationId: string): () => number {
        const entry = this.conversations.get(conversationId)!
        if (entry.warm) {
            const seq = entry.log.tailSeq() ?? entry.historyEndSeq
            return () => seq
        }
        const preceding = new Set(entry.pendingAppends.map(messageKey))
        return () => {
            const messages = entry.log.afterSeq(entry.historyEndSeq)
            for (let index = messages.length - 1; index >= 0; index--) {
                if (preceding.has(messageKey(messages[index]))) {
                    return messages[index].seq
                }
            }
            return (messages[0]?.seq ?? entry.historyEndSeq + 1) - 1
        }
    }

    appendLive(conversationId: string, item: ConversationLogEntryInput) {
        return this.appendTo(conversationId, [item])
    }

    appendReply(conversationId: string, items: ConversationLogEntryInput[]) {
        this.appendTo(conversationId, items)
    }

    lastN(conversationId: string, count: number): ConversationLogMessage[] {
        return this.conversations.get(conversationId)?.log.lastN(count) ?? []
    }

    afterSeq(conversationId: string, seq: number): ConversationLogMessage[] {
        return this.conversations.get(conversationId)?.log.afterSeq(seq) ?? []
    }

    tailSeq(conversationId: string): number | null {
        return this.conversations.get(conversationId)?.log.tailSeq() ?? null
    }

    /**
     * 召回历史读取：等待回填后取「当前触发消息之前」的最近 count 条。
     * 当前消息经身份在日志中定位（与写入侧去重键同构：双方都有 messageId
     * 时只按 ID 判定，任一方缺失才按 (userId, timestamp, content) 三元组
     * 兜底——同用户同秒重复内容的不同消息不得互相冒充）——等待回填或
     * 画像读取期间追加的后续闲聊不会挤入边界，当前消息也不会与历史双份；
     * 定位失败退化为最近 count 条。
     */
    async loadRecallHistory(
        conversationId: string,
        count: number,
        current: RecallMessageIdentity | null
    ): Promise<ConversationLogMessage[]> {
        await this.warmup(conversationId)
        // 先取完整日志定位边界，再截取历史窗口。
        const entries = this.lastN(conversationId, LOG_CAPACITY)
        for (
            let index = entries.length - 1;
            current != null && index >= 0;
            index--
        ) {
            if (matchesCurrentMessage(entries[index], current)) {
                return entries.slice(Math.max(0, index - count), index)
            }
        }
        return entries.slice(Math.max(0, entries.length - count))
    }

    /** 清条目并更新纪元；绑定保留，监听与游标读取继续。 */
    clear(conversationId: string) {
        const entry = this.conversations.get(conversationId)
        if (entry == null) {
            return
        }
        entry.historyEndSeq = entry.log.tailSeq() ?? entry.historyEndSeq
        entry.log.clear()
        entry.pendingAppends = []
    }

    dispose() {
        this.conversations.clear()
    }

    private appendTo(
        conversationId: string,
        items: ConversationLogEntryInput[]
    ) {
        const entry = this.conversations.get(conversationId)
        if (entry == null) return false
        if (entry.backfilling) {
            const knownKeys = new Set(entry.pendingAppends.map(messageKey))
            const added = items.filter((item) => {
                const key = messageKey(item)
                if (knownKeys.has(key)) return false
                knownKeys.add(key)
                return true
            })
            entry.pendingAppends.push(...added)
            return added.length > 0
        }
        const previousSeq = entry.log.tailSeq()
        entry.log.append(items)
        return entry.log.tailSeq() !== previousSeq
    }

    private startBackfill(entry: ConversationLogEntry) {
        entry.backfilling = true
        entry.warmupPromise = (async () => {
            const items = await pullConversationBackfill(entry.bot!, {
                channelId: toBackfillChannelId(entry.binding),
                warmupCount: BACKFILL_WARMUP_COUNT
            })
            const liveKeys = new Set(entry.pendingAppends.map(messageKey))
            entry.log.append(
                items.filter((item) => !liveKeys.has(messageKey(item)))
            )
            entry.historyEndSeq = entry.log.tailSeq() ?? entry.historyEndSeq
            entry.log.append(entry.pendingAppends)
            entry.pendingAppends = []
            entry.backfilling = false
            entry.warm = true
        })()
        void entry.warmupPromise.catch(() => {
            // 保留实时缓冲，后续 warmup 重试时统一按历史、实时顺序入账。
            entry.warmupPromise = null
        })
    }
}
