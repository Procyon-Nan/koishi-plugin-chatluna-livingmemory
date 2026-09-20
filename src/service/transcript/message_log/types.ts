export interface ConversationLogMessage {
    /** 写入时分配的单调序号，滚出不重置；游标与区间读的基础。 */
    seq: number
    /** 平台消息 id，去重首选键。 */
    messageId?: string
    /** 平台用户 id（bot 为 bot selfId）。 */
    userId: string
    /** 记录时点昵称/群名片。 */
    name: string
    /** 纯文本。 */
    content: string
    /** 平台时间戳（毫秒）。 */
    timestamp?: number
    role: 'user' | 'assistant'
    origin: 'live' | 'reply' | 'backfill'
}

export type ConversationLogEntryInput = Omit<ConversationLogMessage, 'seq'>

export interface ConversationLogBinding {
    platform: string
    channelId: string
    guildId?: string
    isDirect: boolean
}
