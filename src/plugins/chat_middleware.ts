import { Context, type Session } from 'koishi'
import type { HumanMessage } from '@langchain/core/messages'
import type { Config } from '../index'
import {
    formatChatLunaTranscriptDiagnostics,
    setLivingMemoryRawContent,
    toChatLunaTranscriptMessageResult,
    toChatLunaTranscriptMessagesWithDiagnostics
} from '../service/chatluna_transcript_adapter'
import { collectUserProfileSpeakerLabels } from '../service/user_profile'
import type { LivingMemoryTranscriptMessage } from '../types'

type PromptSections = {
    snapshot: string
    userProfiles: string
}

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

const formatPromptInjection = (sections: PromptSections) => {
    const snapshot = sections.snapshot.trim()
    const userProfiles = sections.userProfiles.trim()
    const parts: string[] = []

    if (snapshot.length > 0) {
        parts.push(`【你的记忆】\n${snapshot}`)
    }
    if (userProfiles.length > 0) {
        parts.push(`【相关用户画像】\n${userProfiles}`)
    }

    if (parts.length === 0) {
        return null
    }

    return parts.join('\n\n')
}

export async function apply(ctx: Context, config: Config) {
    const logger = ctx.logger('chatluna-livingmemory')
    const debug = (message: string) => {
        if (config.debug) {
            logger.info(message)
        }
    }

    ctx.on(
        'chatluna/before-chat',
        async (
            conversationId,
            message,
            promptVariables,
            chatInterface,
            session
        ) => {
            debug(
                `before-chat: conversationId=${conversationId}, isDirect=${session.isDirect}`
            )

            if (
                !ctx.chatluna_living_memory.shouldHandleSession(
                    session.isDirect
                )
            ) {
                debug(
                    `before-chat skipped: unsupported session, conversationId=${conversationId}, isDirect=${session.isDirect}`
                )
                return
            }

            const fallbackPresetId =
                chatInterface.preset.value?.triggerKeyword?.[0]
            const presetId = ctx.chatluna_living_memory.resolvePresetId(
                message,
                fallbackPresetId
            )

            if (presetId == null) {
                debug(
                    `before-chat skipped: preset unresolved, conversationId=${conversationId}, fallbackPresetId=${fallbackPresetId ?? ''}`
                )
                return
            }
            const speakerName = prepareSpeakerName(session, message)
            writeRawUserContent(message, promptVariables)

            debug(
                `before-chat resolved: conversationId=${conversationId}, presetId=${presetId}, fallbackPresetId=${fallbackPresetId ?? ''}`
            )

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
                debug(
                    [
                        'before-chat recall skipped:',
                        `conversationId=${conversationId}`,
                        `presetId=${presetId}`,
                        `reason=${currentTranscript.reason}`
                    ].join(' ')
                )
                return
            }
            ctx.chatluna_living_memory
                .recordPresetSpeaker(
                    scope,
                    currentTranscript.message.speakerLabel
                )
                .catch((error) => {
                    logger.warn(error)
                })

            let historyMessagesPromise: Promise<
                LivingMemoryTranscriptMessage[]
            > | null = null
            const loadHistoryMessages = () => {
                historyMessagesPromise ??= (async () => {
                    const history = toChatLunaTranscriptMessagesWithDiagnostics(
                        scope,
                        await chatInterface.chatHistory.getMessages()
                    )
                    if (history.diagnostics.length > 0) {
                        debug(
                            [
                                'before-chat recall history transcript diagnostics:',
                                `conversationId=${conversationId}`,
                                `presetId=${presetId}`,
                                `dropped=${history.diagnostics.length}`,
                                formatChatLunaTranscriptDiagnostics(
                                    history.diagnostics
                                )
                            ].join(' ')
                        )
                    }

                    return history.messages
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
                    const injection = formatPromptInjection(sections)
                    if (injection != null) {
                        ctx.chatluna.contextManager.inject({
                            conversationId,
                            name: 'after_user_message',
                            // 交给 ChatLuna core 转成 HumanMessage，避免不同
                            // @langchain/core 实例导致 instanceof 失效。
                            value: injection,
                            once: true
                        })
                        debug(
                            [
                                'before-chat prompt injection queued:',
                                `conversationId=${conversationId}`,
                                `presetId=${presetId}`,
                                `injectionLength=${injection.length}`
                            ].join(' ')
                        )
                    }
                } catch (error) {
                    logger.warn(error)
                }
            }

            const snapshotInjectionStatus = enableSnapshotInjection
                ? 'enabled'
                : 'disabled'
            const userProfileInjectionStatus = enableUserProfileInjection
                ? 'enabled'
                : 'disabled'

            debug(
                [
                    'before-chat recall queued:',
                    `conversationId=${conversationId}`,
                    `presetId=${presetId}`,
                    `snapshotInjection=${snapshotInjectionStatus}`,
                    `snapshotLength=${sections.snapshot.length}`,
                    `userProfileInjection=${userProfileInjectionStatus}`,
                    `userProfilesLength=${sections.userProfiles.length}`
                ].join(' ')
            )

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
            _responseMessage,
            promptVariables,
            chatInterface,
            session
        ) => {
            debug(
                `after-chat: conversationId=${conversationId}, isDirect=${session.isDirect}`
            )

            if (
                !ctx.chatluna_living_memory.shouldHandleSession(
                    session.isDirect
                )
            ) {
                debug(
                    `after-chat skipped: unsupported session, conversationId=${conversationId}, isDirect=${session.isDirect}`
                )
                return
            }

            const fallbackPresetId =
                chatInterface.preset.value?.triggerKeyword?.[0]
            const presetId = ctx.chatluna_living_memory.resolvePresetId(
                sourceMessage,
                fallbackPresetId
            )

            if (presetId == null) {
                debug(
                    `after-chat skipped: preset unresolved, conversationId=${conversationId}, fallbackPresetId=${fallbackPresetId ?? ''}`
                )
                return
            }
            const speakerName = prepareSpeakerName(session, sourceMessage)

            debug(
                `after-chat resolved: conversationId=${conversationId}, presetId=${presetId}, fallbackPresetId=${fallbackPresetId ?? ''}`
            )

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

            const messages = await chatInterface.chatHistory.getMessages()
            const transcript = toChatLunaTranscriptMessagesWithDiagnostics(
                scope,
                messages
            )
            const chatCount =
                typeof promptVariables.chatCount === 'number'
                    ? promptVariables.chatCount
                    : 0

            debug(
                [
                    'after-chat extraction queued:',
                    `conversationId=${conversationId}`,
                    `presetId=${presetId}`,
                    `chatCount=${chatCount}`,
                    `messagesLength=${messages.length}`,
                    `transcriptMessagesLength=${transcript.messages.length}`,
                    `transcriptDiagnosticsLength=${transcript.diagnostics.length}`
                ].join(' ')
            )
            if (transcript.diagnostics.length > 0) {
                debug(
                    [
                        'after-chat extraction transcript diagnostics:',
                        `conversationId=${conversationId}`,
                        `presetId=${presetId}`,
                        `dropped=${transcript.diagnostics.length}`,
                        formatChatLunaTranscriptDiagnostics(
                            transcript.diagnostics
                        )
                    ].join(' ')
                )
            }

            await ctx.chatluna_living_memory.queueExtraction(
                scope,
                chatCount,
                transcript.messages,
                chatInterface.preset.value,
                promptVariables
            )
        }
    )

    ctx.on('chatluna/clear-chat-history', async (conversationId) => {
        await ctx.chatluna_living_memory.cleanupConversation(conversationId)
    })
}
