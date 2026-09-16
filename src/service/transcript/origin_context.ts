/**
 * 提取输入头部与记忆来源标签共用同一组来源短语，保证模型在提取时
 * 看到的会话语境与落库的 sourceLabel 措辞一致。
 */
export interface MemoryTranscriptDirectOriginInput {
    isDirect: true
    speakerLabel: string
    speakerId?: string
}

export interface MemoryTranscriptGuildOriginInput {
    isDirect: false
    /** satori Guild.name 本身可选，缺失时沿用既有头部渲染行为。 */
    guildName: string | undefined
    guildId: string
}

export type MemoryTranscriptOriginInput =
    | MemoryTranscriptDirectOriginInput
    | MemoryTranscriptGuildOriginInput

export interface MemoryTranscriptOrigin {
    header: string
    sourceLabel: string
}

export const buildMemoryTranscriptOrigin = (
    input: MemoryTranscriptOriginInput
): MemoryTranscriptOrigin => {
    if (input.isDirect) {
        return {
            header: `以下是你与${input.speakerLabel}（用户 ID：${input.speakerId}）的聊天记录：`,
            sourceLabel: `来源于与${input.speakerLabel}（用户 ID：${input.speakerId}）的私聊`
        }
    }

    return {
        header: `以下是你在「${input.guildName}」（群聊 ID：${input.guildId}）中的聊天记录：`,
        sourceLabel: `来源于「${input.guildName}」（群聊 ID：${input.guildId}）的群聊`
    }
}
