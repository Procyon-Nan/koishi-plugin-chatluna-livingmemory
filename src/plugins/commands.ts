import { Context } from 'koishi'
import { toCharacterMemoryPresetId } from '../service/memory/helpers'

export function apply(ctx: Context) {
    ctx.command(
        'livingmemory <preset:string> <operation:string> <filter:string> <value:text>',
        '管理指定预设下的记忆与用户画像',
        { authority: 3 }
    )
        .option('character', '-c 使用 Character 预设')
        .action(async ({ session, options }, preset, operation, filter, value) => {
            const commandSession = session!
            if (
                operation !== 'delete' ||
                (filter !== 'text' &&
                    filter !== 'user' &&
                    filter !== 'profile')
            ) {
                return '命令格式：livingmemory [-c] <预设名> delete <text|user|profile> <匹配值>'
            }

            const presetId = options?.character
                ? toCharacterMemoryPresetId(preset)
                : preset

            if (filter === 'profile') {
                const profileId =
                    await ctx.chatluna_living_memory.findUserProfileIdByUser(
                        presetId,
                        commandSession.platform,
                        value
                    )
                if (profileId == null) {
                    return '未查询到该用户画像'
                }

                await commandSession.send(
                    '查询到该用户的画像，输入“ok”以确认删除'
                )
                const confirmation = await commandSession.prompt(
                    (reply) => reply.content,
                    { timeout: 60_000 }
                )
                if (confirmation !== 'ok') {
                    return '操作取消'
                }

                await ctx.chatluna_living_memory.deleteUserProfile(profileId)
                return '已删除用户画像'
            }

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
        })
}
