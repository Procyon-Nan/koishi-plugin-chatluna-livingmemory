import {
    AIMessage,
    type BaseMessage,
    HumanMessage
} from '@langchain/core/messages'
import { Context, type Session } from 'koishi'
import type { Config } from '../index'
import { takeRecentRounds } from '../service/shared/rounds'
import type { MemoryScope } from '../types'

interface CharacterMessage {
    content: string
    name?: string
    id?: string
    messageId?: string
    timestamp?: number
}

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
    persistedHumanMessage?: BaseMessage
    lastResponseMessage?: BaseMessage
    completionMessages?: BaseMessage[]
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

const resolveCurrentUserStableName = (session: Session) => {
    return (
        toNonEmptyString(session.event?.user?.nick) ??
        toNonEmptyString(session.event?.user?.name) ??
        toNonEmptyString(session.author?.username) ??
        toNonEmptyString(session.username) ??
        toNonEmptyString(session.author?.nick) ??
        toNonEmptyString(session.author?.name) ??
        toNonEmptyString(session.userId)
    )
}

const isCurrentSessionUserMessage = (
    session: Session,
    message: CharacterMessage
) => {
    const messageId = toNonEmptyString(message.id)
    const userId = toNonEmptyString(session.userId)

    return messageId != null && userId != null && messageId === userId
}

const resolveCharacterMessageName = (
    session: Session,
    message: CharacterMessage
) => {
    const displayName = toNonEmptyString(message.name)
    const stableName = isCurrentSessionUserMessage(session, message)
        ? resolveCurrentUserStableName(session)
        : undefined

    return {
        name: stableName ?? displayName,
        displayName,
        stableName
    }
}

const assignMessageMetadata = (
    target: BaseMessage,
    source: CharacterMessage,
    nameInfo?: ReturnType<typeof resolveCharacterMessageName>
) => {
    const targetWithMetadata = target as BaseMessage & {
        id?: string
        messageId?: string
        timestamp?: number
    }
    const sourceId = toNonEmptyString(source.id)
    const sourceMessageId = toNonEmptyString(source.messageId)

    if (sourceId != null) {
        targetWithMetadata.id = sourceId
    }
    if (sourceMessageId != null) {
        targetWithMetadata.messageId = sourceMessageId
    }
    if (source.timestamp != null) {
        targetWithMetadata.timestamp = source.timestamp
    }

    target.additional_kwargs = {
        ...target.additional_kwargs,
        raw_content: source.content,
        character_id: sourceId,
        character_message_id: sourceMessageId,
        character_timestamp: source.timestamp,
        character_display_name: nameInfo?.displayName,
        character_stable_name: nameInfo?.stableName
    }

    return target
}

const isBotMessage = (session: Session, message: CharacterMessage) => {
    const messageId = toNonEmptyString(message.id)
    const botIds = [session.bot?.selfId, session.selfId]
        .map((id) => toNonEmptyString(id))
        .filter((id): id is string => id != null)

    if (messageId != null && botIds.includes(messageId)) {
        return true
    }

    const messageName = toNonEmptyString(message.name)
    const botName = toNonEmptyString(session.bot?.user?.name)
    return messageName != null && botName != null && messageName === botName
}

const toHumanMessage = (session: Session, message: CharacterMessage) => {
    const nameInfo = resolveCharacterMessageName(session, message)
    const humanMessage = new HumanMessage({
        content: message.content,
        name: nameInfo.name,
        additional_kwargs: {
            raw_content: message.content
        }
    })

    return assignMessageMetadata(
        humanMessage,
        message,
        nameInfo
    ) as HumanMessage
}

const toAiMessage = (session: Session, message: CharacterMessage) => {
    const nameInfo = resolveCharacterMessageName(session, message)
    const aiMessage = new AIMessage({
        content: message.content,
        name: nameInfo.name,
        additional_kwargs: {
            raw_content: message.content
        }
    })

    return assignMessageMetadata(aiMessage, message, nameInfo)
}

const toLangChainMessages = (
    session: Session,
    messages: CharacterMessage[]
) => {
    return messages.map((message) =>
        isBotMessage(session, message)
            ? toAiMessage(session, message)
            : toHumanMessage(session, message)
    )
}

const isSameCharacterMessage = (
    left: CharacterMessage,
    right?: CharacterMessage
) => {
    if (right == null) {
        return false
    }

    if (left === right) {
        return true
    }

    const leftMessageId = toNonEmptyString(left.messageId)
    const rightMessageId = toNonEmptyString(right.messageId)
    if (
        leftMessageId != null &&
        rightMessageId != null &&
        leftMessageId === rightMessageId &&
        left.id === right.id
    ) {
        return true
    }

    return (
        left.id === right.id &&
        left.timestamp === right.timestamp &&
        left.content === right.content
    )
}

const resolveSpeakerName = (session: Session, message?: CharacterMessage) => {
    if (message != null && isCurrentSessionUserMessage(session, message)) {
        return resolveCurrentUserStableName(session)
    }

    return (
        toNonEmptyString(session.event?.user?.nick) ??
        toNonEmptyString(session.event?.user?.name) ??
        toNonEmptyString(session.author?.username) ??
        toNonEmptyString(session.username) ??
        toNonEmptyString(session.author?.nick) ??
        toNonEmptyString(session.author?.name) ??
        toNonEmptyString(message?.name) ??
        toNonEmptyString(message?.id) ??
        toNonEmptyString(session.userId)
    )
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
    const speakerName = resolveSpeakerName(
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

const countCharacterCompletedRounds = (messages: BaseMessage[]) => {
    let count = 0
    let hasHuman = false
    let inAiBlock = false

    for (const message of messages) {
        const type = message.getType()
        if (type === 'human') {
            hasHuman = true
            inAiBlock = false
            continue
        }

        if (type === 'ai' && hasHuman && !inAiBlock) {
            count += 1
            hasHuman = false
            inAiBlock = true
        }
    }

    return count
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
                isBotMessage(payload.session, payload.focusMessage)
            ) {
                return
            }

            const currentMessage = toHumanMessage(
                payload.session,
                payload.focusMessage
            )
            const historyMessages = payload.messages.filter(
                (message) =>
                    !isSameCharacterMessage(message, payload.focusMessage)
            )

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                currentMessage,
                async () =>
                    toLangChainMessages(payload.session, historyMessages)
            )
        }
    )

    events.on(
        'chatluna_character/after-chat',
        async (payload: CharacterAfterChatEventPayload) => {
            const scope = createCharacterScope(ctx, payload)
            const messages = toLangChainMessages(
                payload.session,
                payload.messages
            )
            const scopeKey = toScopeKey(scope)
            const observedChatCount = countCharacterCompletedRounds(messages)
            const previousChatCount = completedRoundCountByScope.get(scopeKey)
            const currentReplyCompletesRound =
                payload.focusMessage != null &&
                !isBotMessage(payload.session, payload.focusMessage)
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
                    `messagesLength=${messages.length}`,
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
