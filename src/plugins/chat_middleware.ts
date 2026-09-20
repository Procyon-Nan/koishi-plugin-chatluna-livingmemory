import { Context, type Session } from 'koishi'
import {
    AIMessage,
    type HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import type { LivingMemoryConfig } from '../contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../contracts/memory'
import {
    getChatLunaMessageCreatedAt,
    getMessageTextParts,
    setLivingMemoryRawContent,
    toChatLunaTranscriptMessageResult
} from '../service/transcript/chatluna_transcript_adapter'
import { toLogTranscriptMessages } from '../service/transcript/message_log/converter'
import type { ConversationLogEntryInput } from '../service/transcript/message_log/types'
import type { UserSpeakerCache } from '../service/transcript/user_speaker'
import { buildMemoryTranscriptOrigin } from '../service/transcript/origin_context'
import { collectUserProfileSpeakerKeys } from '../service/user_profile'
import {
    renderChatLunaPresetPrompt,
    resolveMainRunConversationId
} from '../service/memory/helpers'
import { toNonEmptyString } from '../service/shared/utils'

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
 * 触发消息条目：先于读取显式补写，消除与平台监听的执行顺序耦合。
 * 透传平台 messageId，使 before-chat 补写、after-chat 交换对与平台监听
 * 三处写入共享同一去重键、只落一条。
 */
export const buildChatLunaSourceEntry = (
    session: Session,
    sourceMessage: HumanMessage
): ConversationLogEntryInput | null => {
    const sourceUserId =
        toNonEmptyString(sourceMessage.id) ?? toNonEmptyString(session.userId)
    const content = getMessageTextParts(sourceMessage).parts.join('\n')
    if (sourceUserId == null || content.trim().length === 0) {
        return null
    }

    return {
        messageId: toNonEmptyString(session.messageId) ?? undefined,
        userId: sourceUserId,
        name:
            toNonEmptyString(session.author?.nick) ??
            toNonEmptyString(session.username) ??
            sourceUserId,
        content,
        timestamp:
            getChatLunaMessageCreatedAt(sourceMessage)?.getTime() ?? Date.now(),
        role: 'user',
        origin: 'live'
    }
}

/**
 * 通道 2：本次交换的 source + response 两条。ChatLuna 虚拟房间没有平台
 * channel 可供监听，这两条是那里唯一的日志来源；平台绑定的房间则与监听
 * 经去重合一。
 */
const buildChatLunaExchangeEntries = (
    session: Session,
    sourceMessage: HumanMessage,
    responseMessage: AIMessage
): ConversationLogEntryInput[] => {
    const sourceEntry = buildChatLunaSourceEntry(session, sourceMessage)
    const responseText = getMessageTextParts(responseMessage).parts.join('\n')
    const botName = toNonEmptyString(session.bot?.user?.name) ?? session.selfId

    return [
        ...(sourceEntry == null
            ? []
            : [{ ...sourceEntry, origin: 'reply' as const }]),
        {
            userId: session.selfId,
            name: botName,
            content: responseText,
            timestamp:
                getChatLunaMessageCreatedAt(responseMessage)?.getTime() ??
                Date.now(),
            role: 'assistant' as const,
            origin: 'reply' as const
        }
    ].filter((entry) => entry.content.trim().length > 0)
}

const writeRawUserContent = (
    message: HumanMessage,
    promptVariables: { prompt?: unknown }
) => {
    const rawContent = promptVariables.prompt
    if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
        return
    }

    setLivingMemoryRawContent(message, rawContent)
}

const formatUserProfileInjection = (userProfiles: string) => {
    const text = userProfiles.trim()
    return text.length > 0 ? `【用户画像】\n${text}` : null
}

const formatSnapshotInjection = (snapshot: string) => {
    const text = snapshot.trim()
    return text.length > 0 ? `【我的记忆】\n${text}` : null
}

interface ChatPresetSource {
    preset: { value?: { triggerKeyword?: string[] } | null }
}

export async function apply(ctx: Context, config: LivingMemoryConfig) {
    const logger = ctx.chatluna_living_memory.memoryLogger.with({
        workflow: 'chat'
    })
    const livingMemory = ctx.chatluna_living_memory
    const activeUserProfileInjections = new Map<string, string>()
    const activeSnapshotInjections = new Map<string, string>()
    // 说话人解析跨轮复用：昵称变更需重启插件后生效，换取不在每轮重复
    // 调用平台 getUser。
    const speakerCache: UserSpeakerCache = new Map()
    const diagnostic = (event: string, fields: Record<string, unknown>) =>
        logger.diagnostic(event, fields)

    ctx.on('dispose', () => {
        livingMemory.clearRecallState()
    })
    const clearActiveInjections = (conversationId: string) => {
        activeUserProfileInjections.delete(conversationId)
        activeSnapshotInjections.delete(conversationId)
    }

    const resolveChatScope = (
        conversationId: string,
        message: HumanMessage,
        chatInterface: ChatPresetSource,
        session: Session,
        events: { skipped: string; resolved: string }
    ): MemoryScope | null => {
        const fallbackPresetId = chatInterface.preset.value?.triggerKeyword?.[0]
        const presetId = ctx.chatluna_living_memory.resolvePresetId(
            message,
            fallbackPresetId
        )
        if (presetId == null) {
            diagnostic(events.skipped, {
                conversationId,
                fallbackPresetId,
                reason: 'preset-unresolved'
            })
            return null
        }
        diagnostic(events.resolved, {
            conversationId,
            presetId,
            fallbackPresetId
        })
        return ctx.chatluna_living_memory.createScope(
            conversationId,
            presetId,
            session.userId,
            session.channelId,
            {
                guildId: session.guildId ?? session.channelId,
                isDirect: session.isDirect,
                platform: session.platform,
                speakerId: session.userId
            }
        )
    }

    const registerInjectionPipeline = (
        stage: 'after_system_prompts' | 'injections',
        injections: Map<string, string>,
        createMessage: (content: string) => SystemMessage | AIMessage,
        tokenRole: 'system' | 'assistant',
        priority: number
    ) => {
        ctx.effect(() =>
            ctx.chatluna.contextManager.pipeline(
                stage,
                async (runtime, next) => {
                    const conversationId = resolveMainRunConversationId(
                        runtime.configurable?.agentContext
                    )
                    if (conversationId != null) {
                        const injection = injections.get(conversationId)
                        if (injection != null) {
                            runtime.result.push(createMessage(injection))
                            runtime.usedTokens +=
                                (await runtime.tokenCounter(injection)) +
                                (await runtime.tokenCounter(tokenRole))
                        }
                    }

                    await next()
                },
                priority
            )
        )
    }

    registerInjectionPipeline(
        'after_system_prompts',
        activeUserProfileInjections,
        (content) => new SystemMessage(content),
        'system',
        0
    )
    registerInjectionPipeline(
        'injections',
        activeSnapshotInjections,
        (content) => new AIMessage(content),
        'assistant',
        -10
    )

    ctx.on(
        'chatluna/before-chat',
        async (
            conversationId,
            message,
            promptVariables,
            chatInterface,
            session
        ) => {
            clearActiveInjections(conversationId)
            diagnostic('chat.before.received', {
                conversationId,
                isDirect: session.isDirect
            })

            const scope = resolveChatScope(
                conversationId,
                message,
                chatInterface,
                session,
                {
                    skipped: 'chat.before.skipped',
                    resolved: 'chat.before.resolved'
                }
            )
            if (scope == null) {
                return
            }
            registerConversationLog(ctx, session, conversationId)
            const sourceEntry = buildChatLunaSourceEntry(session, message)
            if (sourceEntry != null) {
                livingMemory.messageLog.appendLive(
                    [conversationId],
                    sourceEntry
                )
            }
            writeRawUserContent(message, promptVariables)

            const currentTranscript = await toChatLunaTranscriptMessageResult(
                scope,
                session,
                message,
                {
                    fallbackCreatedAt: new Date(),
                    speakerCache
                }
            )
            if (currentTranscript.message == null) {
                diagnostic('chat.recall.skipped', {
                    conversationId,
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
                        'chat.speaker.record.failed',
                        {
                            conversationId: scope.conversationId,
                            presetId: scope.presetId,
                            operation: 'record-preset-speaker'
                        },
                        error
                    )
                })

            let historyMessagesPromise: Promise<
                LivingMemoryTranscriptMessage[]
            > | null = null
            const loadHistoryMessages = () => {
                historyMessagesPromise ??= (async () => {
                    return await toLogTranscriptMessages(
                        scope,
                        session.platform,
                        await livingMemory.messageLog.loadRecallHistory(
                            conversationId,
                            config.recallHistoryMessages,
                            sourceEntry
                        )
                    )
                })()

                return historyMessagesPromise
            }

            const enableSnapshotInjection =
                config.enableSnapshotInjection !== false
            const enableUserProfileInjection =
                config.enableUserProfileInjection === true
            let sections = {
                snapshot: '',
                userProfiles: ''
            }
            if (enableSnapshotInjection || enableUserProfileInjection) {
                try {
                    const historyMessages = enableUserProfileInjection
                        ? await loadHistoryMessages()
                        : []
                    const speakerKeys = collectUserProfileSpeakerKeys([
                        ...historyMessages,
                        currentTranscript.message
                    ])
                    sections =
                        await ctx.chatluna_living_memory.hydratePromptSections(
                            scope,
                            {
                                includeSnapshot: enableSnapshotInjection,
                                speakerKeys
                            }
                        )
                    const userProfileInjection = formatUserProfileInjection(
                        sections.userProfiles
                    )
                    if (userProfileInjection != null) {
                        activeUserProfileInjections.set(
                            conversationId,
                            userProfileInjection
                        )
                        diagnostic('chat.injection.activated', {
                            conversationId,
                            presetId: scope.presetId,
                            stage: 'after_system_prompts',
                            role: 'system',
                            type: 'user-profile',
                            injectionLength: userProfileInjection.length
                        })
                    }

                    const snapshotInjection = formatSnapshotInjection(
                        sections.snapshot
                    )
                    if (snapshotInjection != null) {
                        activeSnapshotInjections.set(
                            conversationId,
                            snapshotInjection
                        )
                        diagnostic('chat.injection.activated', {
                            conversationId,
                            presetId: scope.presetId,
                            stage: 'injections',
                            role: 'assistant',
                            type: 'snapshot',
                            injectionLength: snapshotInjection.length
                        })
                    }
                } catch (error) {
                    logger.warn(
                        'chat.injection.failed',
                        {
                            conversationId: scope.conversationId,
                            presetId: scope.presetId,
                            operation: 'hydrate-prompt-sections'
                        },
                        error
                    )
                }
            }

            const snapshotInjectionStatus = enableSnapshotInjection
                ? 'enabled'
                : 'disabled'
            const userProfileInjectionStatus = enableUserProfileInjection
                ? 'enabled'
                : 'disabled'

            diagnostic('chat.recall.queued', {
                conversationId,
                presetId: scope.presetId,
                snapshotInjection: snapshotInjectionStatus,
                snapshotLength: sections.snapshot.length,
                userProfileInjection: userProfileInjectionStatus,
                userProfilesLength: sections.userProfiles.length
            })

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                currentTranscript.message,
                loadHistoryMessages
            )
        }
    )

    ctx.on(
        'chatluna/after-chat',
        async (
            conversationId,
            sourceMessage,
            responseMessage,
            promptVariables,
            chatInterface,
            session
        ) => {
            clearActiveInjections(conversationId)
            diagnostic('chat.after.received', {
                conversationId,
                isDirect: session.isDirect
            })

            const scope = resolveChatScope(
                conversationId,
                sourceMessage,
                chatInterface,
                session,
                {
                    skipped: 'chat.after.skipped',
                    resolved: 'chat.after.resolved'
                }
            )
            if (scope == null) {
                return
            }
            registerConversationLog(ctx, session, conversationId)
            livingMemory.messageLog.appendReply(
                conversationId,
                buildChatLunaExchangeEntries(
                    session,
                    sourceMessage,
                    responseMessage
                )
            )

            diagnostic('chat.extraction.queued', {
                conversationId,
                presetId: scope.presetId
            })
            const presetTemplate = chatInterface.preset.value
            const sourceLabel =
                toNonEmptyString(session.author?.nick) ??
                toNonEmptyString(session.username) ??
                session.userId ??
                ''

            await ctx.chatluna_living_memory.queueExtraction(scope, {
                resolveTranscriptOrigin: async () => {
                    if (session.isDirect) {
                        return buildMemoryTranscriptOrigin({
                            isDirect: true,
                            speakerLabel: sourceLabel,
                            speakerId: scope.speakerId
                        })
                    }

                    const guild = await session.bot.getGuild(scope.guildId!)
                    return buildMemoryTranscriptOrigin({
                        isDirect: false,
                        guildName: guild.name,
                        guildId: scope.guildId!
                    })
                },
                resolvePresetPrompt: async () =>
                    await renderChatLunaPresetPrompt(
                        ctx,
                        presetTemplate,
                        promptVariables
                    )
            })
        }
    )

    ctx.on('chatluna/after-chat-error', async (_error, conversationId) => {
        clearActiveInjections(conversationId)
    })

    ctx.on('chatluna/clear-chat-history', async (conversationId) => {
        clearActiveInjections(conversationId)
        await ctx.chatluna_living_memory.cleanupConversation(conversationId)
    })
}
