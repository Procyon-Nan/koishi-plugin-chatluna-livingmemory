import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-chatluna/services/chat'
import type {} from '@koishijs/plugin-console'
import { apply as characterMiddlewarePlugin } from './plugins/character_middleware'
import { apply as chatMiddlewarePlugin } from './plugins/chat_middleware'
import { apply as livingMemoryToolsPlugin } from './plugins/living_memory_tools'
import {
    registerEntry as registerWebUIEntry,
    apply as webuiPlugin
} from './plugins/webui'
import { ChatLunaLivingMemoryService } from './service/app/living_memory_service'
import type { LivingMemoryConfig } from './contracts/workflows'

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
        livingMemoryToolsPlugin(ctx, config)

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

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        enableSnapshotInjection: Schema.boolean()
            .description(
                '开启 chatLuna 主插件的记忆注入（character 插件需通过预设中的 {living_memory} 变量注入）'
            )
            .default(true),
        enableUserProfileInjection: Schema.boolean()
            .description('开启用户画像注入。')
            .default(false),
        recallStrategy: Schema.union([
            'embedding-rerank',
            'agentic-recall'
        ] as const)
            .description('记忆召回策略。')
            .default('embedding-rerank'),
        extractionRounds: Schema.number()
            .min(1)
            .max(100)
            .step(1)
            .description(
                '每次提取时使用的最近对话轮数（1 轮 = 1 次用户消息 + 1 次AI回复）。'
            )
            .default(10),
        extractionInterval: Schema.number()
            .min(0)
            .max(100)
            .step(1)
            .description(
                '每隔多少轮对话触发一次记忆提取；设为 0 时不执行自动记忆提取。'
            )
            .default(10),
        recallHistoryWindowRounds: Schema.number()
            .min(1)
            .max(12)
            .step(1)
            .description(
                '记忆召回流程使用的最近对话轮数，用于查询改写和 agentic-recall 规划（1 轮 = 1 次用户消息 + 1 次助手回复）。'
            )
            .default(3),
        debug: Schema.boolean()
            .description('输出记忆召回、记忆总结和触发诊断日志。')
            .default(false)
    }).description('基础配置'),
    Schema.object({
        mainModel: Schema.dynamic('model')
            .description(
                '主 LLM 模型，用于记忆提取和 Dream 记忆整理与合并决策。'
            )
            .default('无'),
        subModel: Schema.dynamic('model')
            .description(
                '子 LLM 模型，用于 embedding-rerank 查询改写和 agentic-recall 记忆召回。'
            )
            .default('无')
    }).description('模型配置'),
    Schema.object({
        memorySearchToolMaxResults: Schema.number()
            .min(1)
            .max(60)
            .step(1)
            .description(
                'living_memory_search 查询工具每次最多返回的记忆条数。'
            )
            .default(30),
        memorySearchMinSimilarity: Schema.number()
            .min(0)
            .max(1)
            .step(0.05)
            .description(
                'living_memory_search 的最低余弦相似度阈值。低于此分数的语义命中将被过滤；' +
                    '设为 0 表示不设阈值。关键词命中的条目不受此限制。'
            )
            .default(0)
    }).description('工具配置'),
    Schema.object({
        enableAutoDream: Schema.boolean()
            .description(
                '当某个预设自上次 Dream 后新增记忆达到阈值时，自动触发该预设的 Dream。'
            )
            .default(false),
        autoDreamMemoryGrowthThreshold: Schema.number()
            .min(10)
            .max(200)
            .step(1)
            .description(
                '自动 Dream 的新增记忆阈值。预设从未执行过 Dream 时，从该预设全部记忆开始计数。'
            )
            .default(30),
        userProfileMemoryLimit: Schema.number()
            .min(5)
            .max(100)
            .step(1)
            .description('生成单个用户画像时可送入 LLM 的相关记忆条数上限。')
            .default(20)
    }).description('Dream 流程配置'),
    Schema.object({
        enableRecallQueryRewrite: Schema.boolean()
            .description(
                '是否在 embedding-rerank 召回前使用 LLM 根据历史信息改写检索的查询文本。'
            )
            .default(false),
        embeddingModel: Schema.dynamic('embeddings')
            .description('用于 embedding-rerank 向量化检索的嵌入模型。')
            .default('无'),
        rerankModel: Schema.dynamic('reranker')
            .description(
                '用于 embedding-rerank 召回结果重排序的 Reranker 模型。'
            )
            .default('无'),
        recallTopK: Schema.number()
            .min(1)
            .max(100)
            .step(1)
            .description(
                'embedding-rerank 每次召回时返回的最相关记忆条数上限。'
            )
            .default(5)
    }).description('embedding-rerank 配置')
])

export * from './types'
export * from './service/app/living_memory_service'
