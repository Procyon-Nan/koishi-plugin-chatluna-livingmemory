import type { ConversationLogEntryInput, ConversationLogMessage } from './types'

const toNonEmpty = (value: string | undefined) => {
    return value != null && value.length > 0 ? value : null
}

/**
 * 去重键：messageId 优先；无 messageId 时退到 (userId, timestamp, content)
 * 三元组——对齐 Character mergeMessages 的既有模式，使同一消息经监听与
 * 回填双通道到达时只落一条。
 */
const messageKey = (message: ConversationLogEntryInput) => {
    const messageId = toNonEmpty(message.messageId)
    if (messageId != null) {
        return `id:${messageId}`
    }
    return `k:${message.userId}:${message.timestamp ?? ''}:${message.content}`
}

/**
 * 单会话内存滚动日志。纪元（clearedAt）拦截清空之前的旧消息复活；
 * 无 timestamp 的实时消息以到达时钟与纪元比较，回填消息没有可靠到达
 * 时钟、由调用方直接丢弃（见 backfill）。
 */
export class ConversationMessageLog {
    private entries: ConversationLogMessage[] = []
    private readonly knownKeys = new Set<string>()
    private nextSeq = 1
    private clearedAt: number | null = null

    constructor(private readonly capacity: number) {}

    append(items: readonly ConversationLogEntryInput[]) {
        for (const item of items) {
            if (!this.acceptedByEpoch(item)) {
                continue
            }
            const key = messageKey(item)
            if (this.knownKeys.has(key)) {
                continue
            }
            this.knownKeys.add(key)
            this.entries.push({ seq: this.nextSeq++, ...item })
        }

        while (this.entries.length > this.capacity) {
            const evicted = this.entries.shift()
            if (evicted != null) {
                this.knownKeys.delete(messageKey(evicted))
            }
        }
    }

    /** 清空条目并推进纪元；绑定与 seq 计数由使用方保留。 */
    clear(clearedAt: number = Date.now()) {
        this.entries = []
        this.knownKeys.clear()
        this.clearedAt = clearedAt
    }

    lastN(count: number): ConversationLogMessage[] {
        if (count <= 0) {
            return []
        }
        return this.entries.slice(-count)
    }

    afterSeq(seq: number): ConversationLogMessage[] {
        return this.entries.filter((entry) => entry.seq > seq)
    }

    tailSeq(): number | null {
        return this.entries.length > 0
            ? this.entries[this.entries.length - 1].seq
            : null
    }

    /** 自某序号以来新写入的条数；日志为空时为 0。滚出不影响单调性。 */
    countSince(seq: number): number {
        const tail = this.tailSeq()
        return tail == null ? 0 : tail - seq
    }

    private acceptedByEpoch(item: ConversationLogEntryInput) {
        if (this.clearedAt == null) {
            return true
        }
        const timestamp = item.timestamp ?? Date.now()
        return timestamp > this.clearedAt
    }
}
