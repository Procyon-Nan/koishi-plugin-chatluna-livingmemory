import type { Context } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    LivingMemoryGetMessagesTool,
    livingMemoryGetMessagesToolDescription
} from '../service/memory/tools/get_messages_tool'
import {
    LivingMemoryEmbeddingSearchTool,
    livingMemoryEmbeddingSearchToolDescription
} from '../service/memory/tools/embedding_search_tool'
import {
    livingMemoryGetMessagesToolName,
    livingMemorySearchToolName
} from '../service/memory/tools/search_contract'
import { LivingMemoryRepository } from '../service/persistence/repository'
import {
    createEmbeddingSearchCache,
    LivingMemoryEmbeddingSearchEngine
} from '../service/workflows/recall/embedding_search_engine'

const toChatLunaStructuredTool = (
    tool: LivingMemoryEmbeddingSearchTool | LivingMemoryGetMessagesTool
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
        const searchEngine = new LivingMemoryEmbeddingSearchEngine(
            ctx,
            config,
            new LivingMemoryRepository(ctx),
            ctx.logger('chatluna-livingmemory')
        )

        const disposeSearch = ctx.chatluna.platform.registerTool(
            livingMemorySearchToolName,
            {
                description: livingMemoryEmbeddingSearchToolDescription,
                selector(_history: unknown[]) {
                    return true
                },
                meta: {
                    ...livingMemoryToolMeta,
                    tags: ['living-memory', 'search']
                },
                createTool() {
                    return toChatLunaStructuredTool(
                        new LivingMemoryEmbeddingSearchTool(
                            searchEngine,
                            createEmbeddingSearchCache(),
                            ctx,
                            config
                        )
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
                        new LivingMemoryGetMessagesTool(ctx, config)
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
