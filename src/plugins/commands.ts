import { Context } from 'koishi'
import { toCharacterMemoryPresetId } from '../service/memory/helpers'

export function apply(ctx: Context) {
    ctx.command(
        'livingmemory <preset:string> [operation:string] [filter:string] [value:text]',
        '管理指定预设下的记忆与用户画像',
        { authority: 3 }
    )
        .option('character', '-c 使用 Character 预设')
        .option('delete', '-d 删除记忆或用户画像')
        .option('text', '-t <value:text> 按文本匹配记忆')
        .option('user', '-u <value:string> 按用户 ID 匹配记忆')
        .option('profile', '-p <value:string> 按用户 ID 匹配画像')
        .action(async ({ session, options }, preset, operation, filter, value) => {
            const commandSession = session!
            const shortFilterCount = [
                options?.text,
                options?.user,
                options?.profile
            ].filter((item) => item != null).length
            const resolvedOperation = options?.delete ? 'delete' : operation
            const resolvedFilter =
                options?.text != null
                    ? 'text'
                    : options?.user != null
                      ? 'user'
                      : options?.profile != null
                        ? 'profile'
                        : filter
            const resolvedValue =
                options?.text ?? options?.user ?? options?.profile ?? value

            if (
                resolvedOperation !== 'delete' ||
                (resolvedFilter !== 'text' &&
                    resolvedFilter !== 'user' &&
                    resolvedFilter !== 'profile') ||
                resolvedValue == null ||
                shortFilterCount > 1
            ) {
                return '命令格式：livingmemory [-c] <预设名> delete <text|user|profile> <匹配值>\n简写：livingmemory [-c] <预设名> -d -<t|u|p> <匹配值>'
            }

            const presetId = options?.character
                ? toCharacterMemoryPresetId(preset)
                : preset

            if (resolvedFilter === 'profile') {
                const profileId =
                    await ctx.chatluna_living_memory.findUserProfileIdByUser(
                        presetId,
                        commandSession.platform,
                        resolvedValue
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
                resolvedFilter === 'text'
                    ? await ctx.chatluna_living_memory.findActiveMemoryIdsByText(
                          presetId,
                          resolvedValue
                      )
                    : await ctx.chatluna_living_memory.findActiveMemoryIdsByUser(
                          presetId,
                          commandSession.platform,
                          resolvedValue
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
