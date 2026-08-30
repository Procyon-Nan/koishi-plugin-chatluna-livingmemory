import { Context } from 'koishi'
import { toCharacterMemoryPresetId } from '../service/memory/helpers'

export function apply(ctx: Context) {
    ctx.command(
        'livingmemory <integration:string> <preset:string> <operation:string> <filter:string> <value:text>',
        '归档指定预设下满足条件的活跃记忆',
        { authority: 3 }
    ).action(
        async (
            { session },
            integration,
            preset,
            operation,
            filter,
            value
        ) => {
            const commandSession = session!
            if (
                (integration !== 'chatluna' && integration !== 'character') ||
                operation !== 'delete' ||
                (filter !== 'text' && filter !== 'user')
            ) {
                return '命令格式：livingmemory <chatluna|character> <预设名> delete <text|user> <匹配值>'
            }

            const presetId =
                integration === 'character'
                    ? toCharacterMemoryPresetId(preset)
                    : preset
            const memoryIds =
                filter === 'text'
                    ? await ctx.chatluna_living_memory.findActiveMemoryIdsByText(
                          presetId,
                          value
                      )
                    : await ctx.chatluna_living_memory.findActiveMemoryIdsByUser(
                          presetId,
                          commandSession.platform,
                          value
                      )

            if (memoryIds.length === 0) {
                return '未查询到满足删除条件的记忆'
            }

            await commandSession.send(
                `查询到 ${memoryIds.length} 条满足删除条件的记忆，输入“ok”以确认删除`
            )
            const confirmation = await commandSession.prompt(
                (reply) => reply.content,
                { timeout: 60_000 }
            )
            if (confirmation !== 'ok') {
                return '操作取消'
            }

            const result =
                await ctx.chatluna_living_memory.archiveActiveMemories(
                    presetId,
                    memoryIds
                )
            return `已归档 ${result.archived} 条记忆`
        }
    )
}
