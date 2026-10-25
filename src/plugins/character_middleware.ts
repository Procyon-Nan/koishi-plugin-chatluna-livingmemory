import { Context, type Session } from 'koishi'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    type CharacterTranscriptSourceMessage as CharacterMessage,
    isCharacterBotMessage,
    isSameCharacterMessage
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
    scopeKey,
    toCharacterMemoryConversationId,
    toCharacterMemoryPresetId
} from '../service/memory/helpers'
import { toNonEmptyString } from '../service/shared/utils'
import { buildSessionLogEntry } from './message_collector'

type PromptSections = {
    snapshot: string
    userProfiles: string
}

interface CharacterChatEventPayload {
    session: Session
    sessionKey: string
    presetName: string
    focusMessage?: CharacterMessage
}

interface CharacterAfterChatEventPayload extends CharacterChatEventPayload {
    messages: readonly CharacterMessage[]
}

interface CharacterClearChatHistoryEventPayload {
    sessionKey: string
    conversationId: string
    isDirect: boolean
}

interface CharacterEventRegistrar {
    on(
        name: 'chatluna_character/before-chat',
        listener: (payload: CharacterChatEventPayload) => void | Promise<void>
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
    payload: CharacterChatEventPayload
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
                userId: message.id,
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
        async (payload: CharacterChatEventPayload) => {
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

            // 首次注册时补写事件 session 的原始平台消息；focus 仅用于定位，
            // 不保证与 session 是同一条消息，不能把 session 正文挂到 focus ID 上。
            const sessionEntry = buildSessionLogEntry(payload.session)
            if (sessionEntry != null) {
                livingMemory.messageLog.appendLive(
                    [scope.conversationId],
                    sessionEntry
                )
            }
            const focusId = toNonEmptyString(payload.focusMessage.messageId)
            const context = await livingMemory.messageLog.loadRecallContext(
                scope.conversationId,
                config.recallHistoryMessages,
                focusId ?? null
            )
            const [currentMessage] = await toLogTranscriptMessages(
                scope,
                payload.session.platform,
                context.current == null ? [] : [context.current]
            )
            if (currentMessage == null) {
                logger.diagnostic('character.before.skipped', {
                    conversationId: scope.conversationId,
                    presetId: scope.presetId,
                    reason: 'current-message-unavailable'
                })
                return
            }
            await ctx.chatluna_living_memory
                .recordPresetSpeaker(scope, currentMessage.speakerLabel)
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

            const history = await toLogTranscriptMessages(
                scope,
                payload.session.platform,
                context.history
            )
            profileSpeakerKeysByScope.set(
                scopeKey(scope),
                collectUserProfileSpeakerKeys([...history, currentMessage])
            )

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                currentMessage,
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

            await ctx.chatluna_living_memory.queueExtraction(scope, {
                resolveTranscriptOrigin: async () => {
                    if (payload.session.isDirect) {
                        const focusUserId = toNonEmptyString(
                            payload.focusMessage?.id
                        )
                        let focusLabel = ''
                        if (focusUserId != null) {
                            focusLabel = await resolveUserSpeaker(
                                payload.session,
                                focusUserId,
                                speakerCache
                            )
                                .then((speaker) => speaker.speakerLabel)
                                .catch(() => '')
                        }
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
                }
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
