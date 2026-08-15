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
import { LivingMemoryCreateMemoryTool } from '../service/memory/tools/create_memory_tool'
import {
    livingMemoryCreateMemoryToolDescription,
    livingMemoryCreateMemoryToolName
} from '../service/memory/tools/create_contract'

const toChatLunaStructuredTool = (
    tool:
        | LivingMemorySearchTool
        | LivingMemoryGetMessagesTool
        | LivingMemoryCreateMemoryTool
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
        const registerLivingMemoryTool = (
            name: string,
            options: {
                description: string
                tags: string[]
                createTool: () => ReturnType<ChatLunaTool['createTool']>
            }
        ) =>
            ctx.chatluna.platform.registerTool(name, {
                description: options.description,
                selector(_history: unknown[]) {
                    return true
                },
                meta: {
                    ...livingMemoryToolMeta,
                    tags: options.tags
                },
                createTool: options.createTool
            })

        const disposeSearch = registerLivingMemoryTool(
            livingMemorySearchToolName,
            {
                description: livingMemorySearchToolDescription,
                tags: ['living-memory', 'search'],
                createTool: () =>
                    toChatLunaStructuredTool(
                        new LivingMemorySearchTool(ctx.chatluna_living_memory)
                    )
            }
        )
        const disposeGetMessages = registerLivingMemoryTool(
            livingMemoryGetMessagesToolName,
            {
                description: livingMemoryGetMessagesToolDescription,
                tags: ['living-memory', 'source', 'messages'],
                createTool: () =>
                    toChatLunaStructuredTool(
                        new LivingMemoryGetMessagesTool(ctx)
                    )
            }
        )
        // 写入型工具默认不注册，由 enableMemoryCreationTool 显式开启。
        const disposeCreateMemory = config.enableMemoryCreationTool
            ? registerLivingMemoryTool(livingMemoryCreateMemoryToolName, {
                  description: livingMemoryCreateMemoryToolDescription,
                  tags: ['living-memory', 'create', 'write'],
                  createTool: () =>
                      toChatLunaStructuredTool(
                          new LivingMemoryCreateMemoryTool(
                              ctx.chatluna_living_memory,
                              config.memoryCreateToolMaxMemories
                          )
                      )
              })
            : null

        ctx.effect(() => {
            return () => {
                disposeSearch()
                disposeGetMessages()
                disposeCreateMemory?.()
            }
        })
    })
}
