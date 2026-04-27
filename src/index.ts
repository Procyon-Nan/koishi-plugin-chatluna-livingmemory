import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-chatluna/services/chat'
import type {} from '@koishijs/plugin-console'
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
        return chatMiddlewarePlugin(ctx, config)
    })
}

export const name = 'chatluna-livingmemory'
export const reusable = false

export const inject = {
    required: ['chatluna', 'database'],
    optional: ['console']
}

const DEFAULT_EXTRACTION_PROMPT = [
    '你是一个长期记忆抽取器。',
    '请从以下对话中抽取适合长期保存的事实性记忆。',
    '输出必须是 JSON 数组。',
    '每个元素格式为 {"type":"identity|preference|fact|plan|context|other","content":"...","keywords":["..."],"summary":"..."}。',
    '只保留高价值、稳定、可复用的信息。',
    '如果没有可提取内容，输出 []。'
].join('\n')

export const Config: Schema<Config> = Schema.object({
    promptVariable: Schema.const('{living_memory}')
        .description(
            '在 ChatLuna 预设提示词中写入该变量即可注入最近一次成功召回的记忆快照。'
        )
        .role('text')
        .default('{living_memory}'),
    extractModel: Schema.dynamic('model')
        .description('用于从对话中提取记忆的 LLM 模型。')
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
            '每次提取时使用的最近对话轮数（1 轮 = 1 条用户消息 + 1 条助手回复）。'
        )
        .default(3),
    extractionInterval: Schema.number()
        .min(1)
        .max(20)
        .step(1)
        .description('每隔多少轮对话触发一次记忆提取。')
        .default(3),
    recallTopK: Schema.number()
        .min(1)
        .max(20)
        .step(1)
        .description('每次召回时返回的最相关记忆条数上限。')
        .default(5),
    maxSnapshotsPerPreset: Schema.number()
        .min(2)
        .max(2)
        .step(1)
        .description('每个预设保留的最大快照数量。')
        .default(2),
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
        .default(false),
    extractionPrompt: Schema.string()
        .role('textarea', { rows: [4, 8] })
        .description(
            '记忆提取时发送给 LLM 的系统提示词。对话内容会追加在提示词之后。'
        )
        .default(DEFAULT_EXTRACTION_PROMPT)
})

export * from './types'
export * from './service/memory'
