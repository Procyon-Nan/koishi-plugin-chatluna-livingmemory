import { Context, type Session } from 'koishi'
import type { Config } from '../index'
import {
    type CharacterTranscriptSourceMessage,
    countCharacterCompletedRounds,
    formatCharacterTranscriptDiagnostics,
    isCharacterBotMessage,
    isSameCharacterMessage,
    resolveCharacterScopeSpeakerName,
    toCharacterTranscriptMessageResult,
    toCharacterTranscriptMessagesWithDiagnostics
} from '../service/character_transcript_adapter'
import { takeRecentRounds } from '../service/shared/rounds'
import type { MemoryScope } from '../types'

type CharacterMessage = CharacterTranscriptSourceMessage

interface CharacterPresetPayload {
    system?: {
        rawString?: string
    }
}

const characterPresetSuffix = '（Character）'

interface CharacterBeforeChatEventPayload {
    session: Session
    sessionKey: string
    conversationId?: string
    presetName: string
    preset?: unknown
    messages: CharacterMessage[]
    focusMessage?: CharacterMessage
    triggerReason?: string
}

interface CharacterAfterChatEventPayload {
    session: Session
    sessionKey: string
    conversationId?: string
    presetName: string
    preset?: unknown
    messages: CharacterMessage[]
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

const toNonEmptyString = (value: unknown) => {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

const isSession = (value: unknown): value is Session => {
    return isRecord(value) && typeof value.isDirect === 'boolean'
}

const toCharacterSessionKey = (session: Session) => {
    const id = toNonEmptyString(
        session.isDirect ? session.userId : session.guildId
    )

    if (id == null) {
        return undefined
    }

    return `${session.isDirect ? 'private' : 'group'}:${id}`
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
    const speakerName = resolveCharacterScopeSpeakerName(
        payload.session,
        payload.focusMessage
    )
    const characterPresetId = `${payload.presetName}${characterPresetSuffix}`

    return ctx.chatluna_living_memory.createScope(
        payload.sessionKey,
        characterPresetId,
        speakerId,
        payload.session.channelId,
        {
            guildId: payload.session.guildId ?? payload.session.channelId,
            isDirect: payload.session.isDirect,
            presetLabel: payload.presetName,
            speakerId,
            speakerName
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

    if (!ctx.chatluna_living_memory.shouldHandleSession(session.isDirect)) {
        return undefined
    }

    const presetName = toNonEmptyString(built.preset)
    const sessionKey = toCharacterSessionKey(session)

    if (presetName == null || sessionKey == null) {
        return undefined
    }

    return ctx.chatluna_living_memory.createScope(
        sessionKey,
        `${presetName}${characterPresetSuffix}`
    )
}

const toScopeKey = (
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
) => {
    return `${scope.presetId}\n${scope.conversationId}`
}

const formatCharacterSystemPrompt = (systemPrompt: string) => {
    const normalized = systemPrompt.trim()
    if (normalized.length === 0) {
        return null
    }

    return [
        '# 当前 Character system prompt（仅用于理解“我”的人设，不要从此处抽取记忆）',
        normalized
    ].join('\n\n')
}

const getCharacterSystemRawString = (preset: unknown) => {
    if (!isRecord(preset)) {
        return undefined
    }

    const system = (preset as CharacterPresetPayload).system
    return toNonEmptyString(system?.rawString)
}

const renderCharacterPresetPromptOverride = async (
    ctx: Context,
    logger: ReturnType<Context['logger']>,
    payload: CharacterAfterChatEventPayload
) => {
    const rawString = getCharacterSystemRawString(payload.preset)
    if (rawString == null) {
        return null
    }

    try {
        const rendered = await ctx.chatluna.promptRenderer.renderTemplate(
            rawString,
            {
                time: '',
                stickers: '',
                status: ''
            },
            {
                configurable: {
                    session: payload.session
                }
            }
        )

        return formatCharacterSystemPrompt(rendered.text)
    } catch (error) {
        logger.warn(error)
        return null
    }
}

export async function apply(ctx: Context, config: Config) {
    const logger = ctx.logger('chatluna-livingmemory')
    const events = ctx as unknown as CharacterEventRegistrar
    const completedRoundCountByScope = new Map<string, number>()
    const debug = (message: string) => {
        if (config.debug) {
            logger.info(message)
        }
    }

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
                    const snapshot =
                        await ctx.chatluna_living_memory.hydratePromptVariable(
                            scope
                        )

                    debug(
                        [
                            'character living_memory rendered:',
                            `conversationId=${scope.conversationId}`,
                            `presetId=${scope.presetId}`,
                            `snapshotLength=${snapshot.length}`
                        ].join(' ')
                    )

                    return snapshot
                } catch (error) {
                    logger.warn(error)
                    return ''
                }
            }
        )
    )

    events.on(
        'chatluna_character/before-chat',
        async (payload: CharacterBeforeChatEventPayload) => {
            const scope = createCharacterScope(ctx, payload)

            debug(
                [
                    'character before-chat:',
                    `conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`
                ].join(' ')
            )

            if (
                payload.focusMessage == null ||
                isCharacterBotMessage(payload.session, payload.focusMessage)
            ) {
                return
            }

            const currentTranscript = toCharacterTranscriptMessageResult(
                scope,
                payload.session,
                payload.focusMessage
            )
            if (currentTranscript.message == null) {
                debug(
                    [
                        'character before-chat skipped:',
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `reason=${currentTranscript.reason}`
                    ].join(' ')
                )
                return
            }

            const historyMessages = payload.messages.filter(
                (message) =>
                    !isSameCharacterMessage(message, payload.focusMessage)
            )

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                currentTranscript.message,
                async () => {
                    const history =
                        toCharacterTranscriptMessagesWithDiagnostics(
                            scope,
                            payload.session,
                            historyMessages
                        )
                    if (history.diagnostics.length > 0) {
                        debug(
                            [
                                'character before-chat history transcript diagnostics:',
                                `conversationId=${scope.conversationId}`,
                                `presetId=${scope.presetId}`,
                                `dropped=${history.diagnostics.length}`,
                                formatCharacterTranscriptDiagnostics(
                                    history.diagnostics
                                )
                            ].join(' ')
                        )
                    }

                    return history.messages
                }
            )
        }
    )

    events.on(
        'chatluna_character/after-chat',
        async (payload: CharacterAfterChatEventPayload) => {
            const scope = createCharacterScope(ctx, payload)
            const transcript = toCharacterTranscriptMessagesWithDiagnostics(
                scope,
                payload.session,
                payload.messages
            )
            if (transcript.diagnostics.length > 0) {
                debug(
                    [
                        'character after-chat transcript diagnostics:',
                        `conversationId=${scope.conversationId}`,
                        `presetId=${scope.presetId}`,
                        `dropped=${transcript.diagnostics.length}`,
                        formatCharacterTranscriptDiagnostics(
                            transcript.diagnostics
                        )
                    ].join(' ')
                )
            }
            const messages = transcript.messages
            const scopeKey = toScopeKey(scope)
            const observedChatCount = countCharacterCompletedRounds(messages)
            const previousChatCount = completedRoundCountByScope.get(scopeKey)
            const currentReplyCompletesRound =
                payload.focusMessage != null &&
                !isCharacterBotMessage(payload.session, payload.focusMessage)
            const chatCount =
                previousChatCount == null
                    ? observedChatCount
                    : currentReplyCompletesRound
                      ? Math.max(previousChatCount + 1, observedChatCount)
                      : previousChatCount

            completedRoundCountByScope.set(scopeKey, chatCount)

            const extractionMessages = currentReplyCompletesRound
                ? takeRecentRounds(
                      messages,
                      config.extractionRounds,
                      'ai-anchored'
                  )
                : []

            debug(
                [
                    'character after-chat:',
                    `conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    `chatCount=${chatCount}`,
                    `messagesLength=${payload.messages.length}`,
                    `transcriptMessagesLength=${messages.length}`,
                    `transcriptDiagnosticsLength=${transcript.diagnostics.length}`,
                    `extractionMessagesLength=${extractionMessages.length}`
                ].join(' ')
            )

            const presetPromptOverride =
                await renderCharacterPresetPromptOverride(ctx, logger, payload)

            await ctx.chatluna_living_memory.queueExtraction(
                scope,
                chatCount,
                messages,
                undefined,
                {},
                {
                    presetPromptOverride,
                    preselectedMessages: extractionMessages
                }
            )
        }
    )

    events.on(
        'chatluna_character/clear-chat-history',
        async (payload: CharacterClearChatHistoryEventPayload) => {
            debug(
                [
                    'character clear-chat-history:',
                    `conversationId=${payload.sessionKey}`,
                    `rawConversationId=${payload.conversationId}`,
                    `isDirect=${payload.isDirect}`
                ].join(' ')
            )

            await ctx.chatluna_living_memory.cleanupConversation(
                payload.sessionKey
            )
            for (const key of completedRoundCountByScope.keys()) {
                if (key.endsWith(`\n${payload.sessionKey}`)) {
                    completedRoundCountByScope.delete(key)
                }
            }
        }
    )
}
