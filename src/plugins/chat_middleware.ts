import { Context } from 'koishi'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { Config } from '../index'

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

            debug(
                `before-chat resolved: conversationId=${conversationId}, presetId=${presetId}, fallbackPresetId=${fallbackPresetId ?? ''}`
            )

            const scope = ctx.chatluna_living_memory.createScope(
                conversationId,
                presetId,
                session.userId,
                session.channelId
            )

            const snapshot =
                await ctx.chatluna_living_memory.hydratePromptVariable(presetId)

            promptVariables.living_memory = snapshot

            const searchText =
                typeof message.additional_kwargs?.raw_content === 'string'
                    ? message.additional_kwargs.raw_content
                    : getMessageContent(message.content)

            debug(
                [
                    'before-chat recall queued:',
                    `conversationId=${conversationId}`,
                    `presetId=${presetId}`,
                    `snapshotLength=${snapshot.length}`,
                    `inputLength=${searchText.trim().length}`
                ].join(' ')
            )

            await ctx.chatluna_living_memory.queueRecall(scope, searchText)
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

            debug(
                `after-chat resolved: conversationId=${conversationId}, presetId=${presetId}, fallbackPresetId=${fallbackPresetId ?? ''}`
            )

            const scope = ctx.chatluna_living_memory.createScope(
                conversationId,
                presetId,
                session.userId,
                session.channelId
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
                messages
            )
        }
    )

    ctx.on('chatluna/clear-chat-history', async (conversationId) => {
        await ctx.chatluna_living_memory.cleanupConversation(conversationId)
    })
}
