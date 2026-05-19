import { resolve } from 'path'
import { Context } from 'koishi'
import type {} from '@koishijs/plugin-console'
import type { Config } from '../index'
import type { JobListQuery, MemoryListQuery, SnapshotListQuery } from '../query'
import {
    deleteChatLunaConversation,
    listChatLunaConversationOptions,
    listChatLunaConversations,
    updateChatLunaConversationUsage
} from '../service/chatluna_conversation_admin'
import type { ChatLunaLivingMemoryService } from '../service/memory'
import type {
    ChatLunaConversationListQuery,
    DeleteChatLunaConversationInput,
    MemoryMutationInput,
    UpdateChatLunaConversationUsageInput
} from '../types'

const packageName = 'koishi-plugin-chatluna-livingmemory'

/**
 * 通过 node_modules symlink 路径注册 entry，而非真实路径。
 * Koishi console 的安全检查要求 prod 路径包含 'node_modules'，
 * 而 external/ 下的插件真实路径不含该关键词，会被 403 拦截。
 */
function resolveEntryViaNodeModules(ctx: Context) {
    const baseDir = ctx.loader?.baseDir ?? process.cwd()
    return {
        dev: resolve(
            baseDir,
            'node_modules',
            packageName,
            'client',
            'index.ts'
        ),
        prod: resolve(baseDir, 'node_modules', packageName, 'dist')
    }
}

const service = (ctx: Context): ChatLunaLivingMemoryService => {
    return ctx.chatluna_living_memory
}

const ok = <T extends unknown[]>(fn: (...args: T) => Promise<void>) => {
    return async (...args: T) => {
        await fn(...args)
        return { success: true as const }
    }
}

export function registerEntry(ctx: Context) {
    const paths = resolveEntryViaNodeModules(ctx)
    ctx.console.addEntry(paths)
}

export function apply(ctx: Context, _config?: Config) {
    ctx.console.addListener(
        'living-memory/listPresetIds',
        async () => await service(ctx).listPresetIds()
    )

    ctx.console.addListener('living-memory/getStatus', async () =>
        service(ctx).getStatus()
    )

    ctx.console.addListener(
        'living-memory/listMemories',
        async (query: MemoryListQuery) => await service(ctx).listMemories(query)
    )

    ctx.console.addListener(
        'living-memory/getMemory',
        async (memoryId: string) => await service(ctx).getMemory(memoryId)
    )

    ctx.console.addListener('living-memory/createMemory', async (input) => {
        const payload = input as {
            conversationId: string
            presetId: string
            userId?: string
            channelId?: string
            memory: MemoryMutationInput
        }

        return await service(ctx).createMemory(
            service(ctx).createScope(
                payload.conversationId,
                payload.presetId,
                payload.userId,
                payload.channelId
            ),
            payload.memory
        )
    })

    ctx.console.addListener(
        'living-memory/updateMemory',
        ok(async (memoryId: string, patch: Partial<MemoryMutationInput>) => {
            await service(ctx).updateMemory(memoryId, patch)
        })
    )

    ctx.console.addListener(
        'living-memory/deleteMemory',
        ok(async (memoryId: string) => {
            await service(ctx).deleteMemory(memoryId)
        })
    )

    ctx.console.addListener(
        'living-memory/listSnapshots',
        async (query: SnapshotListQuery) =>
            await service(ctx).listSnapshots(query)
    )

    ctx.console.addListener(
        'living-memory/deleteSnapshot',
        ok(async (snapshotId: string) => {
            await service(ctx).deleteSnapshot(snapshotId)
        })
    )

    ctx.console.addListener(
        'living-memory/listJobs',
        async (query: JobListQuery) => await service(ctx).listJobs(query)
    )

    ctx.console.addListener(
        'living-memory/runDream',
        async (presetId: string) => await service(ctx).runDream(presetId)
    )

    ctx.console.addListener(
        'living-memory/clearPresetData',
        ok(async (presetId: string) => {
            await service(ctx).clearPresetData(presetId)
        })
    )

    ctx.console.addListener(
        'living-memory/listChatLunaConversations',
        async (query: ChatLunaConversationListQuery) =>
            await listChatLunaConversations(ctx, query ?? {})
    )

    ctx.console.addListener(
        'living-memory/listChatLunaConversationOptions',
        async () => listChatLunaConversationOptions(ctx)
    )

    ctx.console.addListener(
        'living-memory/updateChatLunaConversationUsage',
        async (input: UpdateChatLunaConversationUsageInput) =>
            await updateChatLunaConversationUsage(ctx, input)
    )

    ctx.console.addListener(
        'living-memory/deleteChatLunaConversation',
        async (input: DeleteChatLunaConversationInput) =>
            await deleteChatLunaConversation(ctx, input)
    )
}
