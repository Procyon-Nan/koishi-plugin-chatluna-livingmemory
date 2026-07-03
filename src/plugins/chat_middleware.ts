import { Context, type Session } from 'koishi'
import {
    AIMessage,
    type HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import type { Config } from '../index'
import {
    setLivingMemoryRawContent,
    toChatLunaTranscriptMessageResult,
    toChatLunaTranscriptMessages
} from '../service/chatluna_transcript_adapter'
import { collectUserProfileSpeakerLabels } from '../service/user_profile'
import type { LivingMemoryTranscriptMessage } from '../types'

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

export async function apply(ctx: Context, config: Config) {
    const logger = ctx.logger('chatluna-livingmemory')
    const pendingUserProfiles = new Map<string, string>()
    const pendingSnapshots = new Map<string, string>()
    const debug = (message: string) => {
        if (config.debug) {
            logger.info(message)
        }
    }

    ctx.effect(() =>
        ctx.chatluna.contextManager.pipeline(
            'after_system_prompts',
            async (runtime, next) => {
                const conversationId = runtime.configurable?.conversationId
                if (typeof conversationId === 'string') {
                    const injection = pendingUserProfiles.get(conversationId)
                    if (injection != null) {
                        pendingUserProfiles.delete(conversationId)
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
                if (typeof conversationId === 'string') {
                    const injection = pendingSnapshots.get(conversationId)
                    if (injection != null) {
                        pendingSnapshots.delete(conversationId)
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
                        pendingUserProfiles.set(
                            conversationId,
                            userProfileInjection
                        )
                        debug(
                            [
                                'before-chat user profile injection queued:',
                                `conversationId=${conversationId}`,
                                `presetId=${presetId}`,
                                'stage=after_system_prompts',
                                'role=system',
                                `injectionLength=${userProfileInjection.length}`
                            ].join(' ')
                        )
                    }

                    const snapshotInjection = formatSnapshotInjection(
                        sections.snapshot
                    )
                    if (snapshotInjection != null) {
                        pendingSnapshots.set(conversationId, snapshotInjection)
                        debug(
                            [
                                'before-chat snapshot injection queued:',
                                `conversationId=${conversationId}`,
                                `presetId=${presetId}`,
                                'stage=injections',
                                'role=assistant',
                                `injectionLength=${snapshotInjection.length}`
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
            const transcriptMessages = toChatLunaTranscriptMessages(
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
                    `transcriptMessagesLength=${transcriptMessages.length}`
                ].join(' ')
            )

            await ctx.chatluna_living_memory.queueExtraction(
                scope,
                chatCount,
                transcriptMessages,
                chatInterface.preset.value,
                promptVariables
            )
        }
    )

    ctx.on('chatluna/clear-chat-history', async (conversationId) => {
        pendingUserProfiles.delete(conversationId)
        pendingSnapshots.delete(conversationId)
        await ctx.chatluna_living_memory.cleanupConversation(conversationId)
    })
}
