import type { MemoryScope } from '../../contracts/memory'

export type CreateLivingMemoryScopeOptions = Partial<
    Pick<
        MemoryScope,
        | 'guildId'
        | 'isDirect'
        | 'speakerId'
        | 'speakerName'
        | 'presetLabel'
        | 'platform'
    >
>

export const createLivingMemoryScope = (
    conversationId: string,
    presetId: string,
    userId?: string,
    channelId?: string,
    options: CreateLivingMemoryScopeOptions = {}
): MemoryScope => {
    return {
        conversationId,
        presetId,
        userId,
        channelId,
        ...options
    }
}
