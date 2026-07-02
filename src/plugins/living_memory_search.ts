import type { Context } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { Config } from '../index'
import {
    LivingMemorySearchTool,
    livingMemorySearchToolDescription
} from '../service/memory/search_tool'
import { livingMemorySearchToolName } from '../service/memory/search_contract'

const toChatLunaStructuredTool = (
    tool: LivingMemorySearchTool
): ReturnType<ChatLunaTool['createTool']> => {
    // ChatLuna and this package can resolve different @langchain/core copies in
    // local workspaces, so keep the cast at the registration boundary.
    return tool as unknown as ReturnType<ChatLunaTool['createTool']>
}

const toolMeta = {
    source: 'extension',
    group: 'living-memory',
    tags: ['living-memory', 'search'],
    defaultAvailability: {
        enabled: true,
        main: true,
        chatluna: true,
        characterScope: 'all' as const
    }
}

export function apply(ctx: Context, config: Config) {
    ctx.on('ready', () => {
        const dispose = ctx.chatluna.platform.registerTool(
            livingMemorySearchToolName,
            {
                description: livingMemorySearchToolDescription,
                selector(_history: unknown[]) {
                    return true
                },
                meta: toolMeta,
                createTool() {
                    return toChatLunaStructuredTool(
                        new LivingMemorySearchTool(ctx, config)
                    )
                }
            }
        )

        ctx.effect(() => dispose)
    })
}
