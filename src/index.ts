import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-chatluna/services/chat'

export function apply(ctx: Context) {
    // your plugin code here
    // default model
    // const model = ctx.chatluna.createChatModel(ctx.chatluna.config.defaultModel)
}

export const name = 'chatluna-livingmemory'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export const inject = ['chatluna']
