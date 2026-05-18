import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-chatluna/services/chat'
import type {} from '@koishijs/plugin-console'
import { apply as characterMiddlewarePlugin } from './plugins/character_middleware'
import { apply as chatMiddlewarePlugin } from './plugins/chat_middleware'
import {
    registerEntry as registerWebUIEntry,
    apply as webuiPlugin
} from './plugins/webui'
import { ChatLunaLivingMemoryService } from './service/memory'
import { type LivingMemoryConfig, memoryRecallStrategies } from './types'

export type Config = LivingMemoryConfig

export function apply(ctx: Context, config: Config) {
    ctx.plugin(ChatLunaLivingMemoryService, config)

    ctx.inject(['console'], (ctx) => {
        registerWebUIEntry(ctx)

        ctx.inject(['chatluna_living_memory'], (ctx) => {
            webuiPlugin(ctx, config)
        })
    })

    ctx.inject(['chatluna_living_memory'], (ctx) => {
        chatMiddlewarePlugin(ctx, config)

        ctx.inject(['chatluna_character'], (ctx) => {
            characterMiddlewarePlugin(ctx, config)
        })
    })
}

export const name = 'chatluna-livingmemory'
export const reusable = false

export const inject = {
    required: ['chatluna', 'database'],
    optional: ['console', 'chatluna_character']
}

export const Config: Schema<Config> = Schema.object({
    promptVariable: Schema.const('{living_memory}')
        .description(
            '在 ChatLuna 或 Character 预设提示词中写入该变量即可注入最近一次成功召回的记忆快照。'
        )
        .role('text')
        .default('{living_memory}'),
    extractModel: Schema.dynamic('model')
        .description('用于从对话中提取记忆的 LLM 模型。')
        .default('无'),
    dreamModel: Schema.dynamic('model')
        .description('用于 Dream 记忆整理与合并决策的 LLM 模型。')
        .default('无'),
    enableRecallQueryRewrite: Schema.boolean()
        .description('是否在召回前使用 LLM 根据历史信息改写检索的查询文本。')
        .default(false),
    recallRewriteRounds: Schema.number()
        .min(1)
        .max(12)
        .step(1)
        .description(
            '召回查询改写时使用的最近对话轮数（1 轮 = 1 次用户消息 + 1 次助手回复）。'
        )
        .default(3),
    recallRewriteModel: Schema.dynamic('model')
        .description(
            '用于记忆召回查询改写的 LLM 模型。仅在启用召回查询改写时使用。'
        )
        .default('无'),
    embeddingModel: Schema.dynamic('embeddings')
        .description(
            '用于记忆向量化检索的嵌入模型。仅在召回策略为 embedding-rerank 时需要。'
        )
        .default('无'),
    rerankModel: Schema.dynamic('reranker')
        .description(
            '用于对召回结果重排序的 Reranker 模型。仅在召回策略为 embedding-rerank 时需要。'
        )
        .default('无'),
    extractionRounds: Schema.number()
        .min(1)
        .max(12)
        .step(1)
        .description(
            '每次提取时使用的最近对话轮数（1 轮 = 1 次用户消息 + 1 次AI回复）。'
        )
        .default(10),
    extractionInterval: Schema.number()
        .min(0)
        .max(500)
        .step(1)
        .description(
            '每隔多少轮对话触发一次记忆提取；设为 0 时不执行自动记忆提取。'
        )
        .default(10),
    recallTopK: Schema.number()
        .min(1)
        .max(20)
        .step(1)
        .description('每次召回时返回的最相关记忆条数上限。')
        .default(5),
    recallStrategy: Schema.union(
        memoryRecallStrategies.map((strategy) => Schema.const(strategy))
    )
        .role('radio')
        .description(
            '记忆召回策略。keyword 使用关键词匹配；embedding-rerank 使用向量检索加重排序。'
        )
        .default('keyword'),
    enableKeywordFallback: Schema.boolean()
        .description(
            '当 embedding-rerank 策略失败时，是否自动回退到 keyword 策略。'
        )
        .default(true),
    debug: Schema.boolean()
        .description('输出记忆召回、记忆总结和触发诊断日志。')
        .default(false)
})

export * from './types'
export * from './service/memory'
