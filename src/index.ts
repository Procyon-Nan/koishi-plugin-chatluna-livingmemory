import { Context, Schema } from 'koishi'
import {} from 'koishi-plugin-chatluna/services/chat'
import type {} from '@koishijs/plugin-console'
import { apply as characterMiddlewarePlugin } from './plugins/character_middleware'
import { apply as chatMiddlewarePlugin } from './plugins/chat_middleware'
import { apply as livingMemoryToolsPlugin } from './plugins/living_memory_tools'
import { apply as livingMemoryCommandsPlugin } from './plugins/commands'
import { apply as messageCollectorPlugin } from './plugins/message_collector'
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
        livingMemoryCommandsPlugin(ctx)
        messageCollectorPlugin(ctx)
        void chatMiddlewarePlugin(ctx, config)
        livingMemoryToolsPlugin(ctx, config)

        ctx.inject(['chatluna_character'], (ctx) => {
            void characterMiddlewarePlugin(ctx, config)
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
        debug: Schema.boolean()
            .description(
                '输出 Recall、Extraction、Dream 的完整模型 Prompt、原始响应与诊断事件；包含对话、预设提示词和记忆正文，仅应在访问受控环境启用。'
            )
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
            .default('无'),
        embeddingModel: Schema.dynamic('embeddings')
            .description('用于 embedding-rerank 向量化检索的嵌入模型。')
            .default('无'),
        rerankModel: Schema.dynamic('reranker')
            .description(
                '用于 embedding-rerank 召回结果重排序的 Reranker 模型。'
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
            .default(0),
        enableMemoryCreationTool: Schema.boolean()
            .description(
                '注册 living_memory_create_memory 工具，允许模型在对话中主动创建长期记忆。'
            )
            .default(false),
        memoryCreateToolMaxMemories: Schema.number()
            .min(1)
            .max(60)
            .step(1)
            .description(
                'living_memory_create_memory 单次调用允许提交的记忆条数上限。'
            )
            .default(10)
    }).description('工具配置'),
    Schema.object({
        enableAutoDream: Schema.boolean()
            .description(
                '当某个预设内未完成整理的记忆达到阈值时，自动执行增量 Dream。'
            )
            .default(false),
        autoDreamMemoryGrowthThreshold: Schema.number()
            .min(10)
            .max(200)
            .step(1)
            .description(
                '待整理记忆累计达到该条数时触发一次自动增量 Dream，单次任务也最多整理这么多条。'
            )
            .default(30)
    }).description('Dream 流程配置'),
    Schema.object({
        enableUserProfileInjection: Schema.boolean()
            .description('开启用户画像注入。')
            .default(false),
        userProfileMinMemoryCount: Schema.number()
            .min(1)
            .max(30)
            .step(1)
            .description('生成或更新单个用户画像所需的最少关联活跃记忆条数。')
            .default(3),
        userProfileMemoryLimit: Schema.number()
            .min(5)
            .max(100)
            .step(1)
            .description('生成单个用户画像时可送入 LLM 的相关记忆条数上限。')
            .default(20)
    }).description('用户画像配置'),
    Schema.object({
        enableConversationIsolation: Schema.boolean()
            .description(
                '自动召回和 living_memory_search 仅检索当前会话及预设内全局记忆；用户画像与 Dream 仍在预设内共享。'
            )
            .default(false),
        recallStrategy: Schema.union([
            'embedding-rerank',
            'agentic-recall'
        ] as const)
            .description('记忆召回策略。')
            .default('embedding-rerank'),
        recallIntervalMessages: Schema.number()
            .min(0)
            .max(200)
            .step(1)
            .description(
                '召回窗口：每累计该条数的新聊天消息（包括 bot 未回复的闲聊）自动召回一次记忆；设为 0 时关闭自动召回，每个预设会话首次对话时立即召回一次。'
            )
            .default(10),
        recallHistoryMessages: Schema.number()
            .min(1)
            .max(200)
            .step(1)
            .description(
                '每次召回时取最近该条数的聊天消息作为上下文，用来判断需要回忆哪些记忆。'
            )
            .default(20),
        enableRecallQueryRewrite: Schema.boolean()
            .description(
                '是否在 embedding-rerank 召回前使用 LLM 根据历史信息改写检索的查询文本。'
            )
            .default(false),
        recallTopK: Schema.number()
            .min(1)
            .max(100)
            .step(1)
            .description(
                'embedding-rerank 每次召回时返回的最相关记忆条数上限。'
            )
            .default(5)
    }).description('记忆召回配置'),
    Schema.object({
        extractionWindowMessages: Schema.number()
            .min(0)
            .max(200)
            .step(1)
            .description(
                '提取窗口：未提取的聊天消息累计达到该条数时，自动提取一次记忆；触发本次提取的对话会连带其前方一个提取窗口的聊天消息。设为 0 时关闭自动提取。'
            )
            .default(30),
        extractionIncludeOverheard: Schema.boolean()
            .description(
                '旁听提取：控制 bot 未参与的闲聊是否计入记忆提取。每次对话及其前方一个提取窗口内的消息总是提取；开启后窗口之外的闲聊也一并提取，关闭时丢弃。'
            )
            .default(false),
        enableExtractionWhitelist: Schema.boolean()
            .description(
                '开启自动记忆提取白名单；开启后只有白名单内的会话才会自动提取记忆，关闭时白名单列表不生效。'
            )
            .default(false),
        extractionWhitelist: Schema.array(Schema.string())
            .role('table')
            .description(
                '自动记忆提取白名单，填入群号（群聊）或用户 QQ 号（私聊）；开启白名单但列表为空时不会自动提取任何记忆。'
            )
            .default([])
    }).description('记忆提取配置')
])

export * from './types'
export * from './service/app/living_memory_service'
