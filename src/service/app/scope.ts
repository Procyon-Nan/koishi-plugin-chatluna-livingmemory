import type { MemoryScope } from '../../types'

export type CreateLivingMemoryScopeOptions = Partial<
    Pick<
        MemoryScope,
        'guildId' | 'isDirect' | 'speakerId' | 'speakerName' | 'presetLabel'
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
