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
    setLivingMemoryRawContent,
    takeRecentChatLunaRounds,
    toChatLunaTranscriptMessageResult,
    toChatLunaTranscriptMessages
} from '../service/transcript/chatluna_transcript_adapter'
import type { UserSpeakerCache } from '../service/transcript/user_speaker'
import { collectUserProfileSpeakerKeys } from '../service/user_profile'
import {
    renderChatLunaPresetPrompt,
    resolveMainRunConversationId
} from '../service/memory/helpers'

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
                    return await toChatLunaTranscriptMessages(
                        scope,
                        session,
                        takeRecentChatLunaRounds(
                            await chatInterface.chatHistory.getMessages(),
                            config.recallHistoryWindowRounds
                        ),
                        speakerCache
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

            const completedAt = new Date()
            const sourceTranscript = await toChatLunaTranscriptMessageResult(
                scope,
                session,
                sourceMessage,
                {
                    fallbackCreatedAt: completedAt,
                    speakerCache
                }
            )
            const responseTranscript = await toChatLunaTranscriptMessageResult(
                scope,
                session,
                responseMessage,
                {
                    fallbackCreatedAt: completedAt,
                    speakerCache
                }
            )

            if (
                sourceTranscript.message == null ||
                responseTranscript.message == null
            ) {
                diagnostic('chat.extraction.skipped', {
                    conversationId,
                    presetId: scope.presetId,
                    reason: 'invalid-completed-round',
                    sourceReason: sourceTranscript.reason,
                    responseReason: responseTranscript.reason
                })
                return
            }

            const completedRound = {
                messages: [sourceTranscript.message, responseTranscript.message]
            }

            diagnostic('chat.extraction.queued', {
                conversationId,
                presetId: scope.presetId,
                roundMessages: completedRound.messages.length
            })
            const presetTemplate = chatInterface.preset.value

            await ctx.chatluna_living_memory.queueExtraction(
                scope,
                completedRound,
                {
                    resolveTranscriptHeader: async () => {
                        if (session.isDirect) {
                            return `以下是你与${sourceTranscript.message.speakerLabel}（用户 ID：${scope.speakerId}）的聊天记录：`
                        }

                        const guild = await session.bot.getGuild(
                            scope.guildId!
                        )
                        return `以下是你在「${guild.name}」（群聊 ID：${scope.guildId}）中的聊天记录：`
                    },
                    resolvePresetPrompt: async () =>
                        await renderChatLunaPresetPrompt(
                            ctx,
                            presetTemplate,
                            promptVariables
                        )
                }
            )
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
