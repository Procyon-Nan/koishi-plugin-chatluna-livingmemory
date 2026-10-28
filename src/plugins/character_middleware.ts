import { formatLogScope } from '../service/logging/logger'
import { Context, type Session } from 'koishi'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../contracts/memory'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    type CharacterTranscriptSourceMessage as CharacterMessage,
    isCharacterBotMessage,
    isSameCharacterMessage
} from '../service/transcript/character_transcript_adapter'
import { toLogTranscriptMessages } from '../service/transcript/message_log/converter'
import type { ConversationLogEntryInput } from '../service/transcript/message_log/types'
import { collectUserProfileSpeakerKeys } from '../service/user_profile'
import {
    resolveUserSpeaker,
    type UserSpeakerCache
} from '../service/transcript/user_speaker'
import { buildMemoryTranscriptOrigin } from '../service/transcript/origin_context'
import {
    toCharacterMemoryConversationId,
    toCharacterMemoryPresetId,
    type QueueExtractionOptions
} from '../service/memory/helpers'
import { toNonEmptyString } from '../service/shared/utils'
import {
    apply as applyMessageCollector,
    buildSessionLogEntry
} from './message_collector'

interface CharacterReceptionConfig {
    preset: string
    privateWhitelistMode: boolean
    groupWhitelistMode: boolean
    applyPrivate: string[]
    applyGroup: string[]
    globalPrivateConfig: { preset?: string }
    globalGroupConfig: { preset?: string }
    privateConfigs: Record<string, { preset?: string }>
    configs: Record<string, { preset?: string }>
}

interface CharacterReceptionService {
    ctx: Context
    _config: CharacterReceptionConfig
    preset: { getPresetForCache(name: string): { name: string } }
}

type PromptSections = {
    snapshot: string
    userProfiles: string
}

interface CharacterRound {
    context: Promise<{
        scope: MemoryScope
        currentMessage: LivingMemoryTranscriptMessage | undefined
        history: LivingMemoryTranscriptMessage[]
    }>
    prompt?: Promise<string>
}

interface CharacterChatContext {
    session: Session
    sessionKey: string
    presetName: string
}

interface CharacterAfterChatEventPayload extends CharacterChatContext {
    focusMessage?: CharacterMessage
    messages: readonly CharacterMessage[]
}

interface CharacterClearChatHistoryEventPayload {
    sessionKey: string
    isDirect: boolean
}

interface CharacterEventRegistrar {
    on(
        name: 'chatluna_character/message_collect',
        listener: (session: Session) => void,
        prepend?: boolean
    ): () => boolean
    on(
        name: 'chatluna_character/before-chat',
        listener: (payload: CharacterChatContext) => void | Promise<void>
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

const createCharacterScope = (
    ctx: Context,
    context: CharacterChatContext,
    speakerId: string | undefined
) => {
    return ctx.chatluna_living_memory.createScope(
        context.sessionKey,
        toCharacterMemoryPresetId(context.presetName),
        speakerId,
        context.session.channelId,
        {
            guildId: context.session.guildId ?? context.session.channelId,
            isDirect: context.session.isDirect,
            platform: context.session.platform,
            presetLabel: context.presetName,
            speakerId
        }
    )
}

const resolveCharacterPromptContext = (
    variables: Record<string, unknown>,
    configurable: Record<string, unknown>
): CharacterChatContext | undefined => {
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

    return { session, sessionKey: conversationId, presetName }
}

const formatPromptVariable = (sections: PromptSections) => {
    const { snapshot, userProfiles } = sections
    const parts: string[] = []

    if (userProfiles.length > 0) {
        parts.push(`【用户画像】\n${userProfiles}`)
    }
    if (snapshot.length > 0) {
        parts.push(`【你的记忆】\n''${snapshot}''`)
    }

    return parts.join('\n\n')
}

const registerConversationLog = (
    ctx: Context,
    session: Session,
    conversationId: string
) => {
    ctx.chatluna_living_memory.messageLog.register(
        conversationId,
        {
            platform: session.platform,
            channelId: session.channelId ?? session.userId ?? '',
            guildId: session.guildId ?? undefined,
            isDirect: session.isDirect
        },
        session.bot
    )
}

/**
 * 通道 2：focus 之后的末尾连续 bot 消息段即本次实际发出的回复（分句多条）。
 * 平台侧没发出任何消息（如 <action> 空回复）时不产生条目。
 */
const buildCharacterReplyEntries = (
    session: Session,
    messages: readonly CharacterMessage[],
    focus: CharacterMessage | undefined
): ConversationLogEntryInput[] => {
    let lowerBound = 0
    if (focus != null) {
        for (let index = messages.length - 1; index >= 0; index--) {
            if (isSameCharacterMessage(messages[index], focus)) {
                lowerBound = index + 1
                break
            }
        }
    }

    let end = messages.length
    while (
        end > lowerBound &&
        !isCharacterBotMessage(session, messages[end - 1])
    ) {
        end -= 1
    }
    let start = end
    while (
        start > lowerBound &&
        isCharacterBotMessage(session, messages[start - 1])
    ) {
        start -= 1
    }

    return messages.slice(start, end).flatMap((message) => {
        const content = message.content.trim()
        if (content.length === 0) {
            return []
        }
        return [
            {
                messageId: toNonEmptyString(message.messageId) ?? undefined,
                userId: message.id,
                name: toNonEmptyString(message.name) ?? session.selfId,
                content,
                timestamp: message.timestamp ?? Date.now(),
                role: 'assistant' as const,
                origin: 'reply' as const
            }
        ]
    })
}

export async function apply(ctx: Context, config: LivingMemoryConfig) {
    const logger = ctx.chatluna_living_memory.memoryLogger.with({
        workflow: 'character'
    })
    const events = ctx as unknown as CharacterEventRegistrar
    const livingMemory = ctx.chatluna_living_memory
    const character = (
        ctx as unknown as {
            chatluna_character: CharacterReceptionService
        }
    ).chatluna_character
    const rounds = new WeakMap<Session, CharacterRound>()
    // 说话人解析跨轮复用：昵称变更需重启插件后生效，换取不在每轮重复
    // 调用平台 getUser。
    const speakerCache: UserSpeakerCache = new Map()

    ctx.on('dispose', () => {
        livingMemory.clearExtractionState()
        livingMemory.clearRecallState()
    })

    // Character 每次触发先发出 message_collect，同一个 Session 可用于后续轮次。
    events.on(
        'chatluna_character/message_collect',
        (session) => rounds.delete(session),
        true
    )

    const extractionOptions = (
        session: Session,
        scope: MemoryScope
    ): QueueExtractionOptions => ({
        includeOverheard: config.extractionIncludeOverheard,
        resolveTranscriptOrigin: async () => {
            if (session.isDirect) {
                const speakerLabel = await resolveUserSpeaker(
                    session,
                    scope.speakerId!,
                    speakerCache
                )
                    .then((speaker) => speaker.speakerLabel)
                    .catch(() => '')
                return buildMemoryTranscriptOrigin({
                    isDirect: true,
                    speakerLabel,
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

    const collectMessage = (
        context: CharacterChatContext,
        entry: ConversationLogEntryInput | null
    ) => {
        registerConversationLog(ctx, context.session, context.sessionKey)
        if (entry == null) return
        const cursor =
            config.extractionIncludeOverheard &&
            config.extractionWindowMessages > 0
                ? livingMemory.messageLog.captureCursor(context.sessionKey)
                : undefined
        const appended = livingMemory.messageLog.appendLive(
            context.sessionKey,
            entry
        )
        if (appended && cursor) {
            const scope = createCharacterScope(ctx, context, entry.userId)
            void livingMemory
                .queueExtraction(
                    scope,
                    extractionOptions(context.session, scope),
                    cursor
                )
                .catch((error) => {
                    logger.summary(
                        '记忆提取调度失败',
                        formatLogScope(scope),
                        'warn',
                        error
                    )
                })
        }
    }

    applyMessageCollector(
        ctx,
        (session, entry) => {
            const settings = character._config
            const id = session.isDirect ? session.userId : session.guildId
            const configured = Object.assign(
                {},
                settings,
                session.isDirect
                    ? settings.globalPrivateConfig
                    : settings.globalGroupConfig,
                session.isDirect
                    ? settings.privateConfigs[id]
                    : settings.configs[id]
            )
            const preset = character.preset.getPresetForCache(configured.preset)
            collectMessage(
                {
                    session,
                    sessionKey: toCharacterMemoryConversationId(session)!,
                    presetName: preset.name
                },
                entry
            )
        },
        (session) => {
            if (!character.ctx.filter(session) || ctx.bots[session.uid])
                return false
            const settings = character._config
            return session.isDirect
                ? !settings.privateWhitelistMode ||
                      settings.applyPrivate.includes(session.userId)
                : !settings.groupWhitelistMode ||
                      settings.applyGroup.includes(session.guildId)
        }
    )

    const prepareRound = (context: CharacterChatContext): CharacterRound => {
        const { session, sessionKey } = context
        const existing = rounds.get(session)
        if (existing != null) return existing

        const round: CharacterRound = {
            context: (async () => {
                collectMessage(context, buildSessionLogEntry(session))

                if (
                    config.recallIntervalMessages === 0 &&
                    !config.enableUserProfileInjection
                ) {
                    return {
                        scope: createCharacterScope(
                            ctx,
                            context,
                            session.userId
                        ),
                        currentMessage: undefined,
                        history: []
                    }
                }

                // 回填完成后一次读取末条及前 N 条，画像与召回共用这份窗口。
                await livingMemory.messageLog.warmup(sessionKey)
                const entries = livingMemory.messageLog.lastN(
                    sessionKey,
                    config.recallHistoryMessages + 1
                )
                const currentEntry = entries.pop()
                const scope = createCharacterScope(
                    ctx,
                    context,
                    currentEntry?.userId
                )
                const [currentMessage] = await toLogTranscriptMessages(
                    scope,
                    session.platform,
                    currentEntry == null ? [] : [currentEntry]
                )
                const history = await toLogTranscriptMessages(
                    scope,
                    session.platform,
                    entries
                )
                return { scope, currentMessage, history }
            })()
        }
        rounds.set(session, round)
        return round
    }

    ctx.effect(() =>
        ctx.chatluna.promptRenderer.registerFunctionProvider(
            'living_memory',
            async (_args, variables, configurable) => {
                const promptContext = resolveCharacterPromptContext(
                    variables,
                    configurable
                )

                if (promptContext == null) {
                    return ''
                }

                const round = prepareRound(promptContext)
                round.prompt ??= (async () => {
                    const { scope, currentMessage, history } =
                        await round.context
                    const userProfileInjectionEnabled =
                        config.enableUserProfileInjection === true
                    const messages =
                        currentMessage == null
                            ? history
                            : [...history, currentMessage]
                    const speakerKeys = userProfileInjectionEnabled
                        ? collectUserProfileSpeakerKeys(messages)
                        : []
                    const sections =
                        await ctx.chatluna_living_memory.hydratePromptSections(
                            scope,
                            {
                                speakerKeys
                            }
                        )
                    sections.snapshot = sections.snapshot.trim()
                    sections.userProfiles = sections.userProfiles.trim()
                    const rendered = formatPromptVariable(sections)

                    logger.diagnosticSummary(() => {
                        const details = [
                            formatLogScope(scope),
                            `记忆快照：${sections.snapshot.length} 字符`
                        ]
                        if (userProfileInjectionEnabled) {
                            details.push(
                                `人物画像：${sections.userProfiles.length} 字符`
                            )
                        }
                        return {
                            event: '记忆注入',
                            detail: details.join('; ')
                        }
                    })

                    return rendered
                })()
                return round.prompt
            }
        )
    )

    events.on(
        'chatluna_character/before-chat',
        async (payload: CharacterChatContext) => {
            if (config.recallIntervalMessages === 0) return
            const round = prepareRound(payload)
            const { scope, currentMessage, history } = await round.context

            if (currentMessage == null || currentMessage.role !== 'user') {
                logger.diagnosticSummary(() => ({
                    event: '跳过记忆召回',
                    detail: `${formatLogScope(scope)}; 原因：当前用户消息暂不可用`
                }))
                return
            }
            await ctx.chatluna_living_memory.recordPresetSpeaker(
                scope,
                currentMessage.speakerLabel
            )

            await ctx.chatluna_living_memory.queueRecall(
                scope,
                currentMessage,
                async () => history
            )
        }
    )

    events.on(
        'chatluna_character/after-chat',
        async (payload: CharacterAfterChatEventPayload) => {
            rounds.delete(payload.session)
            const scope = createCharacterScope(
                ctx,
                payload,
                toNonEmptyString(payload.focusMessage?.id) ??
                    toNonEmptyString(payload.session.userId)
            )
            registerConversationLog(ctx, payload.session, scope.conversationId)
            livingMemory.messageLog.appendReply(
                scope.conversationId,
                buildCharacterReplyEntries(
                    payload.session,
                    payload.messages,
                    payload.focusMessage
                )
            )
            if (config.extractionWindowMessages === 0) return
            await livingMemory.queueExtraction(
                scope,
                extractionOptions(payload.session, scope)
            )
        }
    )

    events.on(
        'chatluna_character/clear-chat-history',
        async (payload: CharacterClearChatHistoryEventPayload) => {
            await ctx.chatluna_living_memory.cleanupConversation(
                payload.sessionKey
            )
            logger.diagnosticSummary(() => ({
                event: '会话记忆状态已清除',
                detail: formatLogScope({ conversationId: payload.sessionKey })
            }))
        }
    )
}
