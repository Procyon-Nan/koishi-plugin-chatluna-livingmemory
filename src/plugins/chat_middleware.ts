import { formatLogScope } from '../service/logging/logger'
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
import { resolveMainRunConversationId } from '../service/memory/helpers'
import { toNonEmptyString } from '../service/shared/utils'

const registerConversationLog = (
    ctx: Context,
    session: Session,
    conversationId: string
) => {
    ctx.chatluna_living_memory.messageLog.register(conversationId, {
        platform: session.platform,
        channelId: session.channelId ?? session.userId ?? '',
        guildId: session.guildId ?? undefined,
        isDirect: session.isDirect
    })
}

/**
 * 用户请求先于读取入账；before-chat 与 after-chat 使用同一消息身份去重。
 */
export const buildChatLunaSourceEntry = (
    session: Session,
    sourceMessage: HumanMessage
): ConversationLogEntryInput | null => {
    const sourceUserId =
        toNonEmptyString(sourceMessage.id) ?? toNonEmptyString(session.userId)
    const content = getMessageTextParts(sourceMessage).join('\n')
    if (sourceUserId == null || content.trim().length === 0) {
        return null
    }

    return {
        messageId: toNonEmptyString(session.messageId) ?? undefined,
        userId: sourceUserId,
        // 说话人标签只取用户昵称（event.user.name）：author getter 会用
        // member 覆盖 user，session.username 优先返回群名片，均不可信。
        name: toNonEmptyString(session.event?.user?.name) ?? sourceUserId,
        content,
        timestamp:
            getChatLunaMessageCreatedAt(sourceMessage)?.getTime() ?? Date.now(),
        role: 'user',
        origin: 'live'
    }
}

/**
 * 本次实际交流：source 与 response，用户请求与 before-chat 的记录去重。
 */
const buildChatLunaExchangeEntries = (
    session: Session,
    sourceMessage: HumanMessage,
    responseMessage: AIMessage
): ConversationLogEntryInput[] => {
    const sourceEntry = buildChatLunaSourceEntry(session, sourceMessage)
    const responseText = getMessageTextParts(responseMessage).join('\n')
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
        session: Session
    ): MemoryScope | null => {
        const fallbackPresetId = chatInterface.preset.value?.triggerKeyword?.[0]
        const presetId = ctx.chatluna_living_memory.resolvePresetId(
            message,
            fallbackPresetId
        )
        if (presetId == null) {
            logger.diagnosticSummary(() => ({
                event: '跳过对话记忆处理',
                detail: `${formatLogScope({ conversationId })}; 原因：预设解析失败`
            }))
            return null
        }
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

            const scope = resolveChatScope(
                conversationId,
                message,
                chatInterface,
                session
            )
            if (scope == null) {
                return
            }
            registerConversationLog(ctx, session, conversationId)
            const sourceEntry = buildChatLunaSourceEntry(session, message)
            if (sourceEntry != null) {
                livingMemory.messageLog.appendLive(conversationId, sourceEntry)
            }
            writeRawUserContent(message, promptVariables)

            let currentMessage: LivingMemoryTranscriptMessage | undefined
            if (
                config.recallIntervalMessages > 0 ||
                config.enableUserProfileInjection
            ) {
                const currentTranscript =
                    await toChatLunaTranscriptMessageResult(
                        scope,
                        session,
                        message,
                        { fallbackCreatedAt: new Date(), speakerCache }
                    )
                currentMessage = currentTranscript.message ?? undefined
                if (currentMessage == null) {
                    logger.diagnosticSummary(() => ({
                        event: '当前消息转写跳过',
                        detail: `${formatLogScope(scope)}; 原因：${currentTranscript.reason}`
                    }))
                    return
                }
                await ctx.chatluna_living_memory.recordPresetSpeaker(
                    scope,
                    currentMessage.speakerLabel
                )
            }

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
            if (enableSnapshotInjection || enableUserProfileInjection) {
                const historyMessages = enableUserProfileInjection
                    ? await loadHistoryMessages()
                    : []
                const speakerKeys = enableUserProfileInjection
                    ? collectUserProfileSpeakerKeys([
                          ...historyMessages,
                          currentMessage!
                      ])
                    : []
                const sections =
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
                }

                const snapshotInjection = formatSnapshotInjection(
                    sections.snapshot
                )
                if (snapshotInjection != null) {
                    activeSnapshotInjections.set(
                        conversationId,
                        snapshotInjection
                    )
                }
                logger.diagnosticSummary(() => {
                    const details = [formatLogScope(scope)]
                    if (enableSnapshotInjection) {
                        details.push(
                            `记忆快照：${sections.snapshot.trim().length} 字符`
                        )
                    }
                    if (enableUserProfileInjection) {
                        details.push(
                            `人物画像：${sections.userProfiles.trim().length} 字符`
                        )
                    }
                    return { event: '记忆注入', detail: details.join('; ') }
                })
            }

            if (config.recallIntervalMessages > 0) {
                await ctx.chatluna_living_memory.queueRecall(
                    scope,
                    currentMessage!,
                    loadHistoryMessages
                )
            }
        }
    )

    ctx.on(
        'chatluna/after-chat',
        async (
            conversationId,
            sourceMessage,
            responseMessage,
            _promptVariables,
            chatInterface,
            session
        ) => {
            clearActiveInjections(conversationId)

            const scope = resolveChatScope(
                conversationId,
                sourceMessage,
                chatInterface,
                session
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

            if (config.extractionWindowMessages === 0) return
            const sourceLabel =
                toNonEmptyString(session.event?.user?.name) ??
                session.userId ??
                ''

            await ctx.chatluna_living_memory.queueExtraction(scope, {
                includeOverheard: false,
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
                }
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
