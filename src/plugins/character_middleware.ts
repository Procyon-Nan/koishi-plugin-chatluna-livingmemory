import { Context, type Session } from 'koishi'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    type CharacterTranscriptSourceMessage,
    isCharacterBotMessage,
    isSameCharacterMessage,
    takeRecentCharacterRounds,
    toCharacterCompletedRound,
    toCharacterTranscriptMessageResult,
    toCharacterTranscriptMessages
} from '../service/transcript/character_transcript_adapter'
import { collectUserProfileSpeakerKeys } from '../service/user_profile'
import {
    type CharacterPresetPromptSource,
    renderCharacterPresetPrompt,
    scopeKey,
    toCharacterMemoryConversationId,
    toCharacterMemoryPresetId
} from '../service/memory/helpers'
import { toNonEmptyString } from '../service/shared/utils'

type CharacterMessage = CharacterTranscriptSourceMessage

type PromptSections = {
    snapshot: string
    userProfiles: string
}

interface CharacterBeforeChatEventPayload {
    session: Session
    sessionKey: string
    conversationId?: string
    presetName: string
    preset: CharacterPresetPromptSource
    messages: readonly CharacterMessage[]
    focusMessage?: CharacterMessage
    triggerReason?: string
}

interface CharacterAfterChatEventPayload {
    session: Session
    sessionKey: string
    conversationId?: string
    presetName: string
    preset: CharacterPresetPromptSource
    messages: readonly CharacterMessage[]
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

const isSession = (value: unknown): value is Session => {
    return isRecord(value) && typeof value.isDirect === 'boolean'
}

const createCharacterScope = async (
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

export async function apply(ctx: Context, config: LivingMemoryConfig) {
    const logger = ctx.chatluna_living_memory.memoryLogger.with({
        workflow: 'character'
    })
    const events = ctx as unknown as CharacterEventRegistrar
    const livingMemory = ctx.chatluna_living_memory
    const profileSpeakerKeysByScope = new Map<string, string[]>()

    ctx.on('dispose', () => {
        livingMemory.clearExtractionState()
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
        async (payload: CharacterBeforeChatEventPayload) => {
            const scope = await createCharacterScope(ctx, payload)

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

            const currentTranscript = await toCharacterTranscriptMessageResult(
                scope,
                payload.session,
                payload.focusMessage
            )
            if (currentTranscript.message == null) {
                logger.diagnostic('character.before.skipped', {
                    conversationId: scope.conversationId,
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
                        'character.speaker.record.failed',
                        {
                            conversationId: scope.conversationId,
                            presetId: scope.presetId,
                            operation: 'record-preset-speaker'
                        },
                        error
                    )
                })

            const historyMessages = payload.messages.filter(
                (message) =>
                    !isSameCharacterMessage(message, payload.focusMessage)
            )
            const history = await toCharacterTranscriptMessages(
                scope,
                payload.session,
                takeRecentCharacterRounds(
                    payload.session,
                    historyMessages,
                    config.recallHistoryWindowRounds
                )
            )
            profileSpeakerKeysByScope.set(
                scopeKey(scope),
                collectUserProfileSpeakerKeys([
                    ...history,
                    currentTranscript.message
                ])
            )

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                currentTranscript.message,
                async () => history
            )
        }
    )

    events.on(
        'chatluna_character/after-chat',
        async (payload: CharacterAfterChatEventPayload) => {
            const scope = await createCharacterScope(ctx, payload)
            const messages = await toCharacterTranscriptMessages(
                scope,
                payload.session,
                takeRecentCharacterRounds(
                    payload.session,
                    payload.messages,
                    config.recallHistoryWindowRounds
                )
            )
            const key = scopeKey(scope)
            profileSpeakerKeysByScope.set(
                key,
                collectUserProfileSpeakerKeys(messages)
            )

            const completedRound =
                payload.focusMessage == null
                    ? {
                          round: null,
                          reason: 'focus-message-missing' as const
                      }
                    : await toCharacterCompletedRound(
                          scope,
                          payload.session,
                          payload.messages,
                          payload.focusMessage
                      )

            logger.diagnostic('character.after.received', {
                conversationId: scope.conversationId,
                presetId: scope.presetId,
                messages: payload.messages.length,
                transcriptMessages: messages.length,
                completedRoundMessages:
                    completedRound.round?.messages.length ?? 0,
                completedRoundReason: completedRound.reason
            })

            if (completedRound.round == null) {
                return
            }

            await ctx.chatluna_living_memory.queueExtraction(
                scope,
                completedRound.round,
                {
                    resolvePresetPrompt: async () =>
                        await renderCharacterPresetPrompt(ctx, payload.preset, {
                            session: payload.session
                        })
                }
            )
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
