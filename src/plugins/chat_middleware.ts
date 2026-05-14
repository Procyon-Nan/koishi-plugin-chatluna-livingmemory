import { Context, type Session } from 'koishi'
import type { HumanMessage } from '@langchain/core/messages'
import type { Config } from '../index'
import { setLivingMemoryRawContent } from '../service/message_formatter'

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

            const snapshot =
                await ctx.chatluna_living_memory.hydratePromptVariable(scope)

            promptVariables.living_memory = snapshot

            debug(
                [
                    'before-chat recall queued:',
                    `conversationId=${conversationId}`,
                    `presetId=${presetId}`,
                    `snapshotLength=${snapshot.length}`
                ].join(' ')
            )

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                message,
                async () => await chatInterface.chatHistory.getMessages()
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
            writeRawUserContent(sourceMessage, promptVariables)

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
                    `messagesLength=${messages.length}`
                ].join(' ')
            )

            await ctx.chatluna_living_memory.queueExtraction(
                scope,
                chatCount,
                messages,
                chatInterface.preset.value,
                promptVariables
            )
        }
    )

    ctx.on('chatluna/clear-chat-history', async (conversationId) => {
        await ctx.chatluna_living_memory.cleanupConversation(conversationId)
    })
}
