import { existsSync, realpathSync } from 'fs'
import { resolve } from 'path'
import { Context } from 'koishi'
import type {} from '@koishijs/plugin-console'
import type {
    LivingMemoryPresetExport,
    MemoryMutationInput
} from '../contracts/memory'
import type {
    CreateMemoryRequest,
    JobListQuery,
    MemoryListQuery,
    SnapshotListQuery,
    UserProfileListQuery
} from '../contracts/rpc'
import type { LivingMemoryConfig } from '../contracts/workflows'
import type { ChatLunaLivingMemoryService } from '../service/app/living_memory_service'

const packageName = 'koishi-plugin-chatluna-livingmemory'

function resolveEntryPaths(ctx: Context) {
    const baseDir = ctx.loader?.baseDir ?? process.cwd()
    const packageRoot = resolve(baseDir, 'node_modules', packageName)
    const devPackageRoot = existsSync(packageRoot)
        ? realpathSync(packageRoot)
        : packageRoot

    return {
        dev: resolve(devPackageRoot, 'client', 'index.ts'),
        // Koishi console production path checks require a node_modules path.
        prod: resolve(packageRoot, 'dist')
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
    const paths = resolveEntryPaths(ctx)
    ctx.console.addEntry(paths)
}

export function apply(ctx: Context, _config?: LivingMemoryConfig) {
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
        const payload = input as CreateMemoryRequest

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
        'living-memory/listUserProfiles',
        async (query: UserProfileListQuery) =>
            await service(ctx).listUserProfiles(query)
    )

    ctx.console.addListener(
        'living-memory/deleteUserProfile',
        ok(async (profileId: string) => {
            await service(ctx).deleteUserProfile(profileId)
        })
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
        'living-memory/rebuildEmbeddings',
        async (presetId: string) =>
            await service(ctx).rebuildEmbeddings(presetId)
    )

    ctx.console.addListener(
        'living-memory/exportPreset',
        async (presetId: string) => await service(ctx).exportPreset(presetId)
    )

    ctx.console.addListener(
        'living-memory/importPreset',
        async (targetPresetId: string, data: LivingMemoryPresetExport) =>
            await service(ctx).importPreset(targetPresetId, data)
    )
}
