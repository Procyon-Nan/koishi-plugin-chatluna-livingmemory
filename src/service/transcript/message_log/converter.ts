import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../../contracts/memory'
import { createUserProfileSpeakerKey } from '../../memory/speaker_identity'
import { resolveScopeAssistantLabel } from '../../memory/helpers'
import { createLivingMemoryTranscriptMessageResult } from '../transcript_message'
import type { ConversationLogMessage } from './types'

/**
 * 日志条目 → 模型可见转写消息。角色取写入时确定值，不做 bot 启发式判定。
 * 说话人身份直接由平台 userId 派生 speakerKey，标签用记录时点昵称——
 * 日志含回填历史，getUser 对已退群/改名用户不保证可解析，平台查询在这里
 * 既不可靠也无必要（标签本就只作模型可读展示）。
 */
export const toLogTranscriptMessages = async (
    scope: MemoryScope,
    platform: string,
    entries: readonly ConversationLogMessage[]
): Promise<LivingMemoryTranscriptMessage[]> => {
    const converted = entries.map((entry) => {
        if (entry.role === 'assistant') {
            return createLivingMemoryTranscriptMessageResult({
                role: 'assistant',
                speakerLabel: resolveScopeAssistantLabel(scope),
                content: entry.content,
                createdAt: entry.timestamp,
                stripSpeakerPrefix: false
            })
        }

        const userId = entry.userId
        return createLivingMemoryTranscriptMessageResult({
            role: 'user',
            speakerKey: createUserProfileSpeakerKey(platform, userId),
            speakerLabel: entry.name,
            content: entry.content,
            createdAt: entry.timestamp,
            stripSpeakerPrefix: true
        })
    })

    return converted.flatMap((item) =>
        item.message == null ? [] : [item.message]
    )
}
