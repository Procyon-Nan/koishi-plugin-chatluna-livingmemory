import {
    pullConversationBackfill,
    type ConversationBackfillBot
} from './backfill'
import { ConversationMessageLog } from './message_log'
import type {
    ConversationLogBinding,
    ConversationLogEntryInput,
    ConversationLogMessage
} from './types'

/** 单会话日志容量与冷启动回填预热条数（内部常量，不暴露为配置）。 */
const LOG_CAPACITY = 500
const BACKFILL_WARMUP_COUNT = 200

interface ConversationLogEntry {
    binding: ConversationLogBinding
    bot: ConversationBackfillBot
    log: ConversationMessageLog
    /** 回填进行中：实时与回复消息先入缓冲，回填结束后按序冲刷。 */
    backfilling: boolean
    /** 回填已完成（含适配器不支持而立即结束），此后写入直通。 */
    warm: boolean
    warmupPromise: Promise<void> | null
    pendingAppends: ConversationLogEntryInput[]
}

export const toChannelKey = (platform: string, channelId: string) => {
    return `${platform}:${channelId}`
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
    current: {
        messageId?: string
        userId: string
        content: string
        timestamp?: number
    }
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

/**
 * 会话消息日志注册表：conversationId → 滚动日志，外加
 * (platform, channelId) → 会话集合的渠道索引供平台监听分发。
 * 同 channel 多会话各自入账（重复收集，已知限制）。
 */
export class MessageLogRegistry {
    private readonly conversations = new Map<string, ConversationLogEntry>()
    private readonly channelIndex = new Map<string, Set<string>>()

    register(
        conversationId: string,
        binding: ConversationLogBinding,
        bot: ConversationBackfillBot
    ) {
        const existing = this.conversations.get(conversationId)
        if (existing != null) {
            return
        }

        const entry: ConversationLogEntry = {
            binding,
            bot,
            log: new ConversationMessageLog(LOG_CAPACITY),
            backfilling: true,
            warm: false,
            warmupPromise: null,
            pendingAppends: []
        }
        this.conversations.set(conversationId, entry)

        const channelKey = toChannelKey(binding.platform, binding.channelId)
        let conversations = this.channelIndex.get(channelKey)
        if (conversations == null) {
            conversations = new Set()
            this.channelIndex.set(channelKey, conversations)
        }
        conversations.add(conversationId)

        this.startBackfill(conversationId, entry)
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
            this.startBackfill(conversationId, entry)
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

    conversationIdsByChannel(platform: string, channelId: string) {
        return [
            ...(this.channelIndex.get(toChannelKey(platform, channelId)) ?? [])
        ]
    }

    appendLive(
        conversationIds: readonly string[],
        item: ConversationLogEntryInput
    ) {
        for (const conversationId of conversationIds) {
            this.appendTo(conversationId, [item])
        }
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

    countSince(conversationId: string, seq: number): number {
        return this.conversations.get(conversationId)?.log.countSince(seq) ?? 0
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
        current: {
            messageId?: string
            userId: string
            content: string
            timestamp?: number
        } | null
    ): Promise<ConversationLogMessage[]> {
        await this.warmup(conversationId)
        const entry = this.conversations.get(conversationId)
        if (entry == null) {
            return []
        }
        // capacity + 1 恒覆盖日志在窗全量，定位不因窗口截断漏掉当前消息
        const entries = entry.log.lastN(LOG_CAPACITY + 1)
        if (current == null) {
            return entries.slice(-count)
        }
        for (let index = entries.length - 1; index >= 0; index--) {
            if (matchesCurrentMessage(entries[index], current)) {
                return entries.slice(Math.max(0, index - count), index)
            }
        }
        return entries.slice(-count)
    }

    /** 清条目并更新纪元；绑定保留，监听与游标读取继续。 */
    clear(conversationId: string) {
        const entry = this.conversations.get(conversationId)
        if (entry == null) {
            return
        }
        entry.log.clear()
        entry.pendingAppends = []
    }

    dispose() {
        this.conversations.clear()
        this.channelIndex.clear()
    }

    private appendTo(
        conversationId: string,
        items: ConversationLogEntryInput[]
    ) {
        const entry = this.conversations.get(conversationId)
        if (entry == null) {
            return
        }
        if (entry.backfilling) {
            entry.pendingAppends.push(...items)
            return
        }
        entry.log.append(items)
    }

    private startBackfill(conversationId: string, entry: ConversationLogEntry) {
        const bot = entry.bot
        entry.backfilling = true
        entry.warmupPromise = (async () => {
            const items = await pullConversationBackfill(bot, {
                channelId: toBackfillChannelId(entry.binding),
                warmupCount: BACKFILL_WARMUP_COUNT
            })
            entry.log.append(items)
        })()

        entry.warmupPromise.then(
            () => {
                entry.backfilling = false
                entry.warm = true
                this.flushPending(entry)
            },
            () => {
                // 失败不保留结果：下次 warmup 重新尝试，缓冲照常冲刷。
                if (entry.warmupPromise != null) {
                    entry.warmupPromise = null
                    entry.backfilling = false
                }
                this.flushPending(entry)
            }
        )
    }

    private flushPending(entry: ConversationLogEntry) {
        const buffered = entry.pendingAppends
        entry.pendingAppends = []
        entry.log.append(buffered)
    }
}
