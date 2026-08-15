import { Context, type Session } from 'koishi'
import {
    AIMessage,
    type HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    setLivingMemoryRawContent,
    toChatLunaTranscriptMessageResult,
    toChatLunaTranscriptMessages
} from '../service/transcript/chatluna_transcript_adapter'
import { collectUserProfileSpeakerLabels } from '../service/user_profile'
import type { LivingMemoryTranscriptMessage } from '../contracts/memory'
import { renderChatLunaPresetPrompt } from '../service/memory/helpers'

const toNonEmptyString = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined
}

const resolveSpeakerName = (session: Session, message: HumanMessage) => {
    const messageName = toNonEmptyString((message as { name?: unknown }).name)
    if (messageName != null) {
        return messageName
    }

    return (
        toNonEmptyString(session.author?.nick) ??
        toNonEmptyString(session.author?.name) ??
        toNonEmptyString(session.event?.user?.name) ??
        toNonEmptyString(session.username) ??
        toNonEmptyString(session.userId)
    )
}

const prepareSpeakerName = (session: Session, message: HumanMessage) => {
    const namedMessage = message as { name?: string }
    const existingName = toNonEmptyString(namedMessage.name)
    if (existingName != null) {
        return existingName
    }

    const speakerName = resolveSpeakerName(session, message)
    if (speakerName != null) {
        namedMessage.name = speakerName
    }
    return speakerName
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

const isSubagentPrompt = (agentContext: unknown) => {
    return (
        (agentContext as { kind?: unknown } | null | undefined)?.kind ===
        'subagent'
    )
}

export async function apply(ctx: Context, config: LivingMemoryConfig) {
    const logger = ctx.chatluna_living_memory.memoryLogger.with({
        workflow: 'chat'
    })
    const activeUserProfileInjections = new Map<string, string>()
    const activeSnapshotInjections = new Map<string, string>()
    const diagnostic = (event: string, fields: Record<string, unknown>) =>
        logger.diagnostic(event, fields)
    const clearActiveInjections = (conversationId: string) => {
        activeUserProfileInjections.delete(conversationId)
        activeSnapshotInjections.delete(conversationId)
    }

    ctx.effect(() =>
        ctx.chatluna.contextManager.pipeline(
            'after_system_prompts',
            async (runtime, next) => {
                const conversationId = runtime.configurable?.conversationId
                if (
                    typeof conversationId === 'string' &&
                    !isSubagentPrompt(runtime.configurable?.agentContext)
                ) {
                    const injection =
                        activeUserProfileInjections.get(conversationId)
                    if (injection != null) {
                        runtime.result.push(new SystemMessage(injection))
                        runtime.usedTokens +=
                            (await runtime.tokenCounter(injection)) +
                            (await runtime.tokenCounter('system'))
                    }
                }

                await next()
            },
            0
        )
    )

    ctx.effect(() =>
        ctx.chatluna.contextManager.pipeline(
            'injections',
            async (runtime, next) => {
                const conversationId = runtime.configurable?.conversationId
                if (
                    typeof conversationId === 'string' &&
                    !isSubagentPrompt(runtime.configurable?.agentContext)
                ) {
                    const injection =
                        activeSnapshotInjections.get(conversationId)
                    if (injection != null) {
                        runtime.result.push(new AIMessage(injection))
                        runtime.usedTokens +=
                            (await runtime.tokenCounter(injection)) +
                            (await runtime.tokenCounter('assistant'))
                    }
                }

                await next()
            },
            -10
        )
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

            const fallbackPresetId =
                chatInterface.preset.value?.triggerKeyword?.[0]
            const presetId = ctx.chatluna_living_memory.resolvePresetId(
                message,
                fallbackPresetId
            )

            if (presetId == null) {
                diagnostic('chat.before.skipped', {
                    conversationId,
                    fallbackPresetId,
                    reason: 'preset-unresolved'
                })
                return
            }
            const speakerName = prepareSpeakerName(session, message)
            writeRawUserContent(message, promptVariables)

            diagnostic('chat.before.resolved', {
                conversationId,
                presetId,
                fallbackPresetId
            })

            const scope = ctx.chatluna_living_memory.createScope(
                conversationId,
                presetId,
                session.userId,
                session.channelId,
                {
                    guildId: session.guildId ?? session.channelId,
                    isDirect: session.isDirect,
                    speakerId: session.userId,
                    speakerName
                }
            )

            const currentTranscript = toChatLunaTranscriptMessageResult(
                scope,
                message,
                {
                    fallbackCreatedAt: new Date()
                }
            )
            if (currentTranscript.message == null) {
                diagnostic('chat.recall.skipped', {
                    conversationId,
                    presetId,
                    reason: currentTranscript.reason
                })
                return
            }
            ctx.chatluna_living_memory
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
                    return toChatLunaTranscriptMessages(
                        scope,
                        await chatInterface.chatHistory.getMessages()
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
                    const speakerLabels = collectUserProfileSpeakerLabels([
                        ...historyMessages,
                        currentTranscript.message
                    ])
                    sections =
                        await ctx.chatluna_living_memory.hydratePromptSections(
                            scope,
                            {
                                includeSnapshot: enableSnapshotInjection,
                                speakerLabels
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
                            presetId,
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
                            presetId,
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
                presetId,
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

            const fallbackPresetId =
                chatInterface.preset.value?.triggerKeyword?.[0]
            const presetId = ctx.chatluna_living_memory.resolvePresetId(
                sourceMessage,
                fallbackPresetId
            )

            if (presetId == null) {
                diagnostic('chat.after.skipped', {
                    conversationId,
                    fallbackPresetId,
                    reason: 'preset-unresolved'
                })
                return
            }
            const speakerName = prepareSpeakerName(session, sourceMessage)

            diagnostic('chat.after.resolved', {
                conversationId,
                presetId,
                fallbackPresetId
            })

            const scope = ctx.chatluna_living_memory.createScope(
                conversationId,
                presetId,
                session.userId,
                session.channelId,
                {
                    guildId: session.guildId ?? session.channelId,
                    isDirect: session.isDirect,
                    speakerId: session.userId,
                    speakerName
                }
            )

            const completedAt = new Date()
            const sourceTranscript = toChatLunaTranscriptMessageResult(
                scope,
                sourceMessage,
                { fallbackCreatedAt: completedAt }
            )
            const responseTranscript = toChatLunaTranscriptMessageResult(
                scope,
                responseMessage,
                { fallbackCreatedAt: completedAt }
            )

            if (
                sourceTranscript.message == null ||
                responseTranscript.message == null
            ) {
                diagnostic('chat.extraction.skipped', {
                    conversationId,
                    presetId,
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
                presetId,
                roundMessages: completedRound.messages.length
            })
            const presetTemplate = chatInterface.preset.value

            await ctx.chatluna_living_memory.queueExtraction(
                scope,
                completedRound,
                {
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
