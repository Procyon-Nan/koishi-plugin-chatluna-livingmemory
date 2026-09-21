import { Context, type Session } from 'koishi'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    type CharacterTranscriptSourceMessage,
    isCharacterBotMessage,
    isSameCharacterMessage,
    toCharacterTranscriptMessageResult
} from '../service/transcript/character_transcript_adapter'
import { toLogTranscriptMessages } from '../service/transcript/message_log/converter'
import type { ConversationLogEntryInput } from '../service/transcript/message_log/types'
import { collectUserProfileSpeakerKeys } from '../service/user_profile'
import {
    resolveUserSpeaker,
    type UserSpeakerCache
} from '../service/transcript/user_speaker'
import { buildMemoryTranscriptOrigin } from '../service/transcript/origin_context'
import {
    type CharacterPresetPromptSource,
    renderCharacterPresetPrompt,
    scopeKey,
    toCharacterMemoryConversationId,
    toCharacterMemoryPresetId
} from '../service/memory/helpers'
import { toNonEmptyString } from '../service/shared/utils'

type CharacterMessage = CharacterTranscriptSourceMessage

type PromptSections = {
    snapshot: string
    userProfiles: string
}

interface CharacterBeforeChatEventPayload {
    session: Session
    sessionKey: string
    conversationId?: string
    presetName: string
    preset: CharacterPresetPromptSource
    messages: readonly CharacterMessage[]
    focusMessage?: CharacterMessage
    triggerReason?: string
}

interface CharacterAfterChatEventPayload {
    session: Session
    sessionKey: string
    conversationId?: string
    presetName: string
    preset: CharacterPresetPromptSource
    messages: readonly CharacterMessage[]
    focusMessage?: CharacterMessage
    triggerReason?: string
    persistedHumanMessage?: unknown
    lastResponseMessage?: unknown
    completionMessages?: unknown[]
    status?: string | null
}

interface CharacterClearChatHistoryEventPayload {
    sessionKey: string
    conversationId: string
    isDirect: boolean
}

interface CharacterEventRegistrar {
    on(
        name: 'chatluna_character/before-chat',
        listener: (
            payload: CharacterBeforeChatEventPayload
        ) => void | Promise<void>
    ): () => boolean
    on(
        name: 'chatluna_character/after-chat',
        listener: (
            payload: CharacterAfterChatEventPayload
        ) => void | Promise<void>
    ): () => boolean
    on(
        name: 'chatluna_character/clear-chat-history',
        listener: (
            payload: CharacterClearChatHistoryEventPayload
        ) => void | Promise<void>
    ): () => boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

const isSession = (value: unknown): value is Session => {
    return isRecord(value) && typeof value.isDirect === 'boolean'
}

const createCharacterScope = (
    ctx: Context,
    payload: {
        session: Session
        sessionKey: string
        presetName: string
        focusMessage?: CharacterMessage
    }
) => {
    const speakerId =
        toNonEmptyString(payload.focusMessage?.id) ??
        toNonEmptyString(payload.session.userId)
    const characterPresetId = toCharacterMemoryPresetId(payload.presetName)

    return ctx.chatluna_living_memory.createScope(
        payload.sessionKey,
        characterPresetId,
        speakerId,
        payload.session.channelId,
        {
            guildId: payload.session.guildId ?? payload.session.channelId,
            isDirect: payload.session.isDirect,
            platform: payload.session.platform,
            presetLabel: payload.presetName,
            speakerId
        }
    )
}

const createCharacterPromptScope = (
    ctx: Context,
    variables: Record<string, unknown>,
    configurable: Record<string, unknown>
) => {
    const built = variables.built
    const session = configurable.session

    if (!isRecord(built) || !isSession(session)) {
        return undefined
    }

    const presetName = toNonEmptyString(built.preset)
    if (presetName == null) {
        return undefined
    }

    const conversationId = toCharacterMemoryConversationId(session)
    if (conversationId == null) {
        return undefined
    }

    return ctx.chatluna_living_memory.createScope(
        conversationId,
        toCharacterMemoryPresetId(presetName)
    )
}

const formatPromptVariable = (sections: PromptSections) => {
    const snapshot = sections.snapshot.trim()
    const userProfiles = sections.userProfiles.trim()
    const parts: string[] = []

    if (userProfiles.length > 0) {
        parts.push(`【用户画像】\n${userProfiles}`)
    }
    if (snapshot.length > 0) {
        parts.push(`【你的记忆】\n''${snapshot}''`)
    }

    return parts.join('\n\n')
}

const registerConversationLog = (
    ctx: Context,
    session: Session,
    conversationId: string
) => {
    ctx.chatluna_living_memory.messageLog.register(
        conversationId,
        {
            platform: session.platform,
            channelId: session.channelId ?? session.userId ?? '',
            guildId: session.guildId ?? undefined,
            isDirect: session.isDirect
        },
        session.bot
    )
}

/**
 * 触发消息条目：先于读取显式补写，消除与平台监听的执行顺序耦合（去重保证单条）。
 * focus 作者是重读消息列表的末条，与事件 session 用户不保证同一人，昵称必须
 * 用按 focus 用户 ID 解析出的 speakerLabel，不得从 session 推断。
 */
const buildCharacterUserEntry = (
    speakerLabel: string,
    message: CharacterMessage
): ConversationLogEntryInput | null => {
    const content = message.content.trim()
    const userId = toNonEmptyString(message.id)
    if (content.length === 0 || userId == null) {
        return null
    }

    return {
        messageId: toNonEmptyString(message.messageId) ?? undefined,
        userId,
        name: speakerLabel,
        content,
        timestamp: message.timestamp ?? Date.now(),
        role: 'user',
        origin: 'live'
    }
}

/**
 * 通道 2：focus 之后的末尾连续 bot 消息段即本次实际发出的回复（分句多条）。
 * 平台侧没发出任何消息（如 <action> 空回复）时不产生条目。
 */
const buildCharacterReplyEntries = (
    session: Session,
    messages: readonly CharacterMessage[],
    focus: CharacterMessage | undefined
): ConversationLogEntryInput[] => {
    let lowerBound = 0
    if (focus != null) {
        for (let index = messages.length - 1; index >= 0; index--) {
            if (isSameCharacterMessage(messages[index], focus)) {
                lowerBound = index + 1
                break
            }
        }
    }

    let end = messages.length
    while (
        end > lowerBound &&
        !isCharacterBotMessage(session, messages[end - 1])
    ) {
        end -= 1
    }
    let start = end
    while (
        start > lowerBound &&
        isCharacterBotMessage(session, messages[start - 1])
    ) {
        start -= 1
    }

    return messages.slice(start, end).flatMap((message) => {
        const content = message.content.trim()
        if (content.length === 0) {
            return []
        }
        return [
            {
                messageId: toNonEmptyString(message.messageId) ?? undefined,
                userId: toNonEmptyString(message.id) ?? session.selfId,
                name: toNonEmptyString(message.name) ?? session.selfId,
                content,
                timestamp: message.timestamp ?? Date.now(),
                role: 'assistant' as const,
                origin: 'reply' as const
            }
        ]
    })
}

export async function apply(ctx: Context, config: LivingMemoryConfig) {
    const logger = ctx.chatluna_living_memory.memoryLogger.with({
        workflow: 'character'
    })
    const events = ctx as unknown as CharacterEventRegistrar
    const livingMemory = ctx.chatluna_living_memory
    const profileSpeakerKeysByScope = new Map<string, string[]>()
    // 说话人解析跨轮复用：昵称变更需重启插件后生效，换取不在每轮重复
    // 调用平台 getUser。
    const speakerCache: UserSpeakerCache = new Map()

    ctx.on('dispose', () => {
        livingMemory.clearExtractionState()
        livingMemory.clearRecallState()
    })

    ctx.effect(() =>
        ctx.chatluna.promptRenderer.registerFunctionProvider(
            'living_memory',
            async (_args, variables, configurable) => {
                const scope = createCharacterPromptScope(
                    ctx,
                    variables,
                    configurable
                )

                if (scope == null) {
                    return ''
                }

                try {
                    const userProfileInjectionEnabled =
                        config.enableUserProfileInjection === true
                    let speakerKeys: string[] = []
                    if (userProfileInjectionEnabled) {
                        const profileScopeKey = scopeKey(scope)
                        speakerKeys =
                            profileSpeakerKeysByScope.get(profileScopeKey) ?? []
                    }
                    const sections =
                        await ctx.chatluna_living_memory.hydratePromptSections(
                            scope,
                            {
                                speakerKeys
                            }
                        )
                    const rendered = formatPromptVariable(sections)

                    logger.diagnostic('character.injection.rendered', {
                        conversationId: scope.conversationId,
                        presetId: scope.presetId,
                        snapshotLength: sections.snapshot.length,
                        userProfileInjection: userProfileInjectionEnabled
                            ? 'enabled'
                            : 'disabled',
                        userProfilesLength: sections.userProfiles.length
                    })

                    return rendered
                } catch (error) {
                    logger.warn(
                        'character.injection.failed',
                        {
                            conversationId: scope.conversationId,
                            presetId: scope.presetId,
                            operation: 'render-prompt-variable'
                        },
                        error
                    )
                    return ''
                }
            }
        )
    )

    events.on(
        'chatluna_character/before-chat',
        async (payload: CharacterBeforeChatEventPayload) => {
            const scope = createCharacterScope(ctx, payload)
            registerConversationLog(ctx, payload.session, scope.conversationId)

            logger.diagnostic('character.before.received', {
                conversationId: scope.conversationId,
                presetId: scope.presetId
            })

            if (
                payload.focusMessage == null ||
                isCharacterBotMessage(payload.session, payload.focusMessage)
            ) {
                return
            }

            const currentTranscript = await toCharacterTranscriptMessageResult(
                scope,
                payload.session,
                payload.focusMessage,
                speakerCache
            )
            if (currentTranscript.message == null) {
                logger.diagnostic('character.before.skipped', {
                    conversationId: scope.conversationId,
                    presetId: scope.presetId,
                    reason: currentTranscript.reason
                })
                return
            }
            await ctx.chatluna_living_memory
                .recordPresetSpeaker(
                    scope,
                    currentTranscript.message.speakerLabel
                )
                .catch((error) => {
                    logger.warn(
                        'character.speaker.record.failed',
                        {
                            conversationId: scope.conversationId,
                            presetId: scope.presetId,
                            operation: 'record-preset-speaker'
                        },
                        error
                    )
                })

            const focusEntry = buildCharacterUserEntry(
                currentTranscript.message.speakerLabel,
                payload.focusMessage
            )
            if (focusEntry != null) {
                livingMemory.messageLog.appendLive(
                    [scope.conversationId],
                    focusEntry
                )
            }

            const history = await toLogTranscriptMessages(
                scope,
                payload.session.platform,
                await livingMemory.messageLog.loadRecallHistory(
                    scope.conversationId,
                    config.recallHistoryMessages,
                    focusEntry
                )
            )
            profileSpeakerKeysByScope.set(
                scopeKey(scope),
                collectUserProfileSpeakerKeys([
                    ...history,
                    currentTranscript.message
                ])
            )

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                currentTranscript.message,
                async () => history
            )
        }
    )

    events.on(
        'chatluna_character/after-chat',
        async (payload: CharacterAfterChatEventPayload) => {
            const scope = createCharacterScope(ctx, payload)
            registerConversationLog(ctx, payload.session, scope.conversationId)
            livingMemory.messageLog.appendReply(
                scope.conversationId,
                buildCharacterReplyEntries(
                    payload.session,
                    payload.messages,
                    payload.focusMessage
                )
            )
            const messages = await toLogTranscriptMessages(
                scope,
                payload.session.platform,
                await livingMemory.messageLog.loadRecallHistory(
                    scope.conversationId,
                    config.recallHistoryMessages,
                    null
                )
            )
            const key = scopeKey(scope)
            profileSpeakerKeysByScope.set(
                key,
                collectUserProfileSpeakerKeys(messages)
            )

            logger.diagnostic('character.after.received', {
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                messages: payload.messages.length,
                transcriptMessages: messages.length
            })

            // 标签按 focus 用户 ID 解析（与 before-chat 共享缓存）；
            // 解析失败不阻断提取，退空串。
            const focusUserId = toNonEmptyString(payload.focusMessage?.id)
            const focusLabel =
                focusUserId == null
                    ? ''
                    : await resolveUserSpeaker(
                          payload.session,
                          focusUserId,
                          speakerCache
                      )
                          .then((speaker) => speaker.speakerLabel)
                          .catch(() => '')

            await ctx.chatluna_living_memory.queueExtraction(scope, {
                resolveTranscriptOrigin: async () => {
                    if (payload.session.isDirect) {
                        return buildMemoryTranscriptOrigin({
                            isDirect: true,
                            speakerLabel: focusLabel,
                            speakerId: scope.speakerId
                        })
                    }

                    const guild = await payload.session.bot.getGuild(
                        scope.guildId!
                    )
                    return buildMemoryTranscriptOrigin({
                        isDirect: false,
                        guildName: guild.name,
                        guildId: scope.guildId!
                    })
                },
                resolvePresetPrompt: async () =>
                    await renderCharacterPresetPrompt(ctx, payload.preset, {
                        session: payload.session
                    })
            })
        }
    )

    events.on(
        'chatluna_character/clear-chat-history',
        async (payload: CharacterClearChatHistoryEventPayload) => {
            logger.diagnostic('character.history.cleared', {
                conversationId: payload.sessionKey,
                rawConversationId: payload.conversationId,
                isDirect: payload.isDirect
            })

            await ctx.chatluna_living_memory.cleanupConversation(
                payload.sessionKey
            )
            for (const key of profileSpeakerKeysByScope.keys()) {
                if (key.endsWith(`\n${payload.sessionKey}`)) {
                    profileSpeakerKeysByScope.delete(key)
                }
            }
        }
    )
}
