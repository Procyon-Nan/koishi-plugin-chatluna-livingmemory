import type { Context } from 'koishi'
import { ModelType } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type {
    BindingRecord,
    ConversationRecord
} from 'koishi-plugin-chatluna/services/chat'
import type { PageResult } from '../query'
import type {
    ChatLunaConversationListItem,
    ChatLunaConversationListQuery,
    ChatLunaConversationOptions,
    ChatLunaConversationRouteInfo,
    DeleteChatLunaConversationInput,
    UpdateChatLunaConversationUsageInput
} from '../types'

const defaultPage = 1
const defaultPageSize = 20
const maxPageSize = 100

function normalizePage(value: number | undefined) {
    if (value == null || !Number.isFinite(value)) return defaultPage
    return Math.max(1, Math.floor(value))
}

function normalizePageSize(value: number | undefined) {
    if (value == null || !Number.isFinite(value)) return defaultPageSize
    return Math.min(maxPageSize, Math.max(1, Math.floor(value)))
}

function toTimestamp(value: Date | string | null | undefined) {
    if (value == null) return 0
    const date = value instanceof Date ? value : new Date(value)
    const time = date.getTime()
    return Number.isFinite(time) ? time : 0
}

function unique<T>(items: T[], resolveKey: (item: T) => string) {
    const result: T[] = []
    const keys = new Set<string>()

    for (const item of items) {
        const key = resolveKey(item)
        if (keys.has(key)) continue
        keys.add(key)
        result.push(item)
    }

    return result
}

function parseRouteInfo(bindingKey: string): ChatLunaConversationRouteInfo {
    const presetMarker = ':preset:'
    const presetIndex = bindingKey.indexOf(presetMarker)
    const baseBindingKey =
        presetIndex >= 0 ? bindingKey.slice(0, presetIndex) : bindingKey
    const presetLane =
        presetIndex >= 0
            ? bindingKey.slice(presetIndex + presetMarker.length) || null
            : null
    const parts = baseBindingKey.split(':')

    if (parts[0] === 'custom') {
        return {
            mode: 'custom',
            baseBindingKey,
            presetLane,
            routeKey: parts.slice(1).join(':') || null,
            isDirect: null
        }
    }

    if (parts[0] === 'shared' && parts.length >= 4) {
        return {
            mode: 'shared',
            baseBindingKey,
            presetLane,
            platform: parts[1],
            selfId: parts[2],
            guildId: parts[3],
            isDirect: false
        }
    }

    if (parts[0] === 'personal' && parts.length >= 5) {
        const direct = parts[3] === 'direct'

        return {
            mode: 'personal',
            baseBindingKey,
            presetLane,
            platform: parts[1],
            selfId: parts[2],
            guildId: direct ? null : parts[3],
            userId: parts[4],
            isDirect: direct
        }
    }

    return {
        mode: 'unknown',
        baseBindingKey,
        presetLane,
        isDirect: null
    }
}

function createListItem(
    conversation: ConversationRecord,
    activeConversationId?: string | null
): ChatLunaConversationListItem {
    return {
        id: conversation.id,
        seq: conversation.seq,
        bindingKey: conversation.bindingKey,
        title: conversation.title,
        model: conversation.model,
        preset: conversation.preset,
        chatMode: conversation.chatMode,
        createdBy: conversation.createdBy,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastChatAt: conversation.lastChatAt,
        status: conversation.status,
        isCurrent: activeConversationId === conversation.id,
        activeConversationId: activeConversationId ?? null,
        route: parseRouteInfo(conversation.bindingKey)
    }
}

function includesKeyword(item: ChatLunaConversationListItem, keyword: string) {
    const values = [
        item.id,
        item.title,
        item.model,
        item.preset,
        item.chatMode,
        item.createdBy,
        item.status,
        item.bindingKey,
        item.activeConversationId,
        item.route.mode,
        item.route.platform,
        item.route.selfId,
        item.route.userId,
        item.route.guildId,
        item.route.routeKey,
        item.route.presetLane
    ]

    return values.some((value) =>
        String(value ?? '')
            .toLocaleLowerCase()
            .includes(keyword)
    )
}

function getModelValues(options: ChatLunaConversationOptions) {
    return new Set(options.models.map((model) => model.value))
}

function getPresetValues(options: ChatLunaConversationOptions) {
    return new Set(options.presets.map((preset) => preset.value))
}

async function unbindConversation(ctx: Context, conversationId: string) {
    const [active, last] = await Promise.all([
        ctx.database.get('chatluna_binding', {
            activeConversationId: conversationId
        }),
        ctx.database.get('chatluna_binding', {
            lastConversationId: conversationId
        })
    ])
    const bindings = Array.from(
        new Map(
            [...(active as BindingRecord[]), ...(last as BindingRecord[])].map(
                (binding) => [binding.bindingKey, binding]
            )
        ).values()
    )

    for (const binding of bindings) {
        await ctx.database.upsert('chatluna_binding', [
            {
                bindingKey: binding.bindingKey,
                activeConversationId:
                    binding.activeConversationId === conversationId
                        ? null
                        : binding.activeConversationId,
                lastConversationId:
                    binding.lastConversationId === conversationId
                        ? null
                        : binding.lastConversationId,
                updatedAt: new Date()
            }
        ])
    }
}

export function listChatLunaConversationOptions(
    ctx: Context
): ChatLunaConversationOptions {
    const modelItems = ctx.chatluna.platform
        .listAllModels(ModelType.llm)
        .value.map((model) => ({
            label: model.toModelName(),
            value: model.toModelName(),
            platform: String(model.platform),
            name: model.name
        }))
        .sort((left, right) => left.value.localeCompare(right.value))

    const presetItems = ctx.chatluna.preset
        .getAllPreset(false)
        .value.map((preset) => ({
            label: preset,
            value: preset
        }))
        .sort((left, right) => left.value.localeCompare(right.value))

    return {
        models: unique(modelItems, (item) => item.value),
        presets: unique(presetItems, (item) => item.value)
    }
}

export async function listChatLunaConversations(
    ctx: Context,
    query: ChatLunaConversationListQuery
): Promise<PageResult<ChatLunaConversationListItem>> {
    const page = normalizePage(query.page)
    const pageSize = normalizePageSize(query.pageSize)
    const keyword = query.keyword?.trim().toLocaleLowerCase()
    const conversations = (await ctx.database.get('chatluna_conversation', {
        status: 'active'
    })) as ConversationRecord[]
    const bindings = (await ctx.database.get(
        'chatluna_binding',
        {}
    )) as BindingRecord[]
    const activeByBindingKey = new Map(
        bindings.map((binding) => [
            binding.bindingKey,
            binding.activeConversationId ?? null
        ])
    )

    const items = conversations
        .map((conversation) =>
            createListItem(
                conversation,
                activeByBindingKey.get(conversation.bindingKey)
            )
        )
        .filter((item) =>
            keyword == null || keyword.length === 0
                ? true
                : includesKeyword(item, keyword)
        )
        .sort((left, right) => {
            const route = left.route.baseBindingKey.localeCompare(
                right.route.baseBindingKey
            )
            if (route !== 0) return route

            const bindingKey = left.bindingKey.localeCompare(right.bindingKey)
            if (bindingKey !== 0) return bindingKey

            const seq = (left.seq ?? 0) - (right.seq ?? 0)
            if (seq !== 0) return seq

            const created =
                toTimestamp(left.createdAt) - toTimestamp(right.createdAt)
            if (created !== 0) return created

            return left.id.localeCompare(right.id)
        })
    const start = (page - 1) * pageSize

    return {
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        total: items.length
    }
}

export async function updateChatLunaConversationUsage(
    ctx: Context,
    input: UpdateChatLunaConversationUsageInput
): Promise<ChatLunaConversationListItem> {
    const conversationId = input.conversationId?.trim()
    if (conversationId == null || conversationId.length === 0) {
        throw new Error('Conversation id is required.')
    }

    const conversation =
        await ctx.chatluna.conversation.getConversation(conversationId)
    if (conversation == null) {
        throw new Error('Conversation not found.')
    }

    if (conversation.status !== 'active') {
        throw new Error('Only active conversations can be updated.')
    }

    const options = listChatLunaConversationOptions(ctx)
    const modelValues = getModelValues(options)
    const presetValues = getPresetValues(options)
    const patch: Partial<ConversationRecord> = {}
    const model = input.model?.trim()
    const preset = input.preset?.trim()

    if (model != null) {
        if (!modelValues.has(model)) {
            throw new Error(`Model is unavailable: ${model}`)
        }
        patch.model = model
    }

    if (preset != null) {
        if (!presetValues.has(preset)) {
            throw new Error(`Preset is unavailable: ${preset}`)
        }
        patch.preset = preset
    }

    if (patch.model == null && patch.preset == null) {
        throw new Error('No conversation usage change provided.')
    }

    const updated = await ctx.chatluna.conversation.touchConversation(
        conversation.id,
        patch
    )
    if (updated == null) {
        throw new Error('Conversation not found.')
    }

    await ctx.chatluna.clearCache(updated)

    const binding = await ctx.chatluna.conversation.getBinding(
        updated.bindingKey
    )

    return createListItem(updated, binding?.activeConversationId ?? null)
}

export async function deleteChatLunaConversation(
    ctx: Context,
    input: DeleteChatLunaConversationInput
): Promise<{ success: true }> {
    const conversationId = input.conversationId?.trim()
    if (conversationId == null || conversationId.length === 0) {
        throw new Error('Conversation id is required.')
    }

    const conversation =
        await ctx.chatluna.conversation.getConversation(conversationId)
    if (conversation == null) {
        throw new Error('Conversation not found.')
    }

    if (conversation.status !== 'active') {
        throw new Error('Only active conversations can be deleted.')
    }

    await ctx.root.parallel('chatluna/before-conversation-delete', {
        conversation
    })

    const updated = await ctx.chatluna.conversation.touchConversation(
        conversation.id,
        {
            status: 'deleted',
            archivedAt: null,
            archiveId: null
        }
    )
    if (updated == null) {
        throw new Error('Conversation not found.')
    }

    await unbindConversation(ctx, conversation.id)
    await ctx.database.remove('chatluna_message', {
        conversationId: conversation.id
    })
    await ctx.chatluna.conversation.removeAcl(conversation.id)
    await ctx.chatluna.clearCache(updated)
    await ctx.root.parallel('chatluna/after-conversation-delete', {
        conversation: updated
    })

    return { success: true }
}
