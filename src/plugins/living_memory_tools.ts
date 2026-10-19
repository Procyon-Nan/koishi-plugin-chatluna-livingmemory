import type { StructuredTool } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { LivingMemoryConfig } from '../contracts/workflows'
import {
    memorySearchTool,
    memoryGetMessagesTool,
    memoryCreateTool,
    memoryUpdateTool,
    memoryMergeTool,
    memoryDeleteTool
} from '../service/prompts/memory_tools'
import { createMemoryTool } from '../service/memory/tools'

export function apply(ctx: Context, config: LivingMemoryConfig) {
    if (!config.enableMemoryTools) {
        return
    }

    ctx.on('ready', () => {
        const register = (
            definition: { name: string; description: string },
            tags: string[],
            createTool: () => StructuredTool
        ) =>
            ctx.chatluna.platform.registerTool(definition.name, {
                description: definition.description,
                selector: () => true,
                meta: {
                    source: 'extension',
                    group: 'living-memory',
                    tags: ['living-memory', ...tags],
                    defaultAvailability: {
                        enabled: true,
                        main: true,
                        subAgent: false,
                        chatluna: true,
                        characterScope: 'all'
                    }
                },
                // 工作区可能解析到多份 LangChain，类型转换只保留在注册边界。
                createTool: () =>
                    createTool() as unknown as ReturnType<
                        ChatLunaTool['createTool']
                    >
            })

        const disposers = [
            register(memorySearchTool, ['search'], () =>
                createMemoryTool.search(
                    ctx.chatluna_living_memory,
                    true,
                    config.enableConversationIsolation
                )
            ),
            register(memoryGetMessagesTool, ['source', 'messages'], () =>
                createMemoryTool.getMessages(ctx.chatluna_living_memory)
            ),
            register(memoryCreateTool, ['create', 'write'], () =>
                createMemoryTool.create(
                    ctx.chatluna_living_memory,
                    config.memoryCreateToolMaxMemories
                )
            ),
            register(memoryUpdateTool, ['update', 'write'], () =>
                createMemoryTool.update(ctx.chatluna_living_memory)
            ),
            register(memoryMergeTool, ['merge', 'write'], () =>
                createMemoryTool.merge(ctx.chatluna_living_memory)
            ),
            register(memoryDeleteTool, ['delete', 'write'], () =>
                createMemoryTool.delete(ctx.chatluna_living_memory)
            )
        ]

        ctx.effect(() => () => {
            for (const dispose of disposers) {
                dispose()
            }
        })
    })
}
