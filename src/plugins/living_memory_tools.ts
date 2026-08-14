import type { Context } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    LivingMemoryGetMessagesTool,
    livingMemoryGetMessagesToolDescription
} from '../service/memory/tools/get_messages_tool'
import {
    LivingMemorySearchTool,
    livingMemorySearchToolDescription
} from '../service/memory/tools/embedding_search_tool'
import {
    livingMemoryGetMessagesToolName,
    livingMemorySearchToolName
} from '../service/memory/tools/search_contract'

const toChatLunaStructuredTool = (
    tool: LivingMemorySearchTool | LivingMemoryGetMessagesTool
): ReturnType<ChatLunaTool['createTool']> => {
    // ChatLuna and this package can resolve different @langchain/core copies in
    // local workspaces, so keep the cast at the registration boundary.
    return tool as unknown as ReturnType<ChatLunaTool['createTool']>
}

const livingMemoryToolMeta = {
    source: 'extension',
    group: 'living-memory',
    defaultAvailability: {
        enabled: true,
        main: true,
        chatluna: true,
        characterScope: 'all' as const
    }
}

export function apply(ctx: Context, config: LivingMemoryConfig) {
    ctx.on('ready', () => {
        const disposeSearch = ctx.chatluna.platform.registerTool(
            livingMemorySearchToolName,
            {
                description: livingMemorySearchToolDescription,
                selector(_history: unknown[]) {
                    return true
                },
                meta: {
                    ...livingMemoryToolMeta,
                    tags: ['living-memory', 'search']
                },
                createTool() {
                    return toChatLunaStructuredTool(
                        new LivingMemorySearchTool(ctx.chatluna_living_memory)
                    )
                }
            }
        )
        const disposeGetMessages = ctx.chatluna.platform.registerTool(
            livingMemoryGetMessagesToolName,
            {
                description: livingMemoryGetMessagesToolDescription,
                selector(_history: unknown[]) {
                    return true
                },
                meta: {
                    ...livingMemoryToolMeta,
                    tags: ['living-memory', 'source', 'messages']
                },
                createTool() {
                    return toChatLunaStructuredTool(
                        new LivingMemoryGetMessagesTool(ctx)
                    )
                }
            }
        )

        ctx.effect(() => {
            return () => {
                disposeSearch()
                disposeGetMessages()
            }
        })
    })
}
