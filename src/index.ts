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
            .description('开启 ChatLuna 主插件的记忆快照注入。')
            .default(true),
        debug: Schema.boolean()
            .description(
                '记录 Recall、Extraction、Dream 每次模型调用的完整 Prompt、原始响应与诊断事件。'
            )
            .default(false)
    }).description('基础配置'),
    Schema.object({
        mainModel: Schema.dynamic('model')
            .description('主 LLM 模型，用于提取记忆、Dream 与用户画像。')
            .default('无'),
        subModel: Schema.dynamic('model')
            .description('子 LLM 模型，用于召回记忆。')
            .default('无'),
        embeddingModel: Schema.dynamic('embeddings')
            .description('嵌入模型，用于记忆检索与 Dream。')
            .default('无'),
        rerankModel: Schema.dynamic('reranker')
            .description('Reranker 模型，用于记忆检索结果重排序。')
            .default('无')
    }).description('模型配置'),
    Schema.object({
        memorySearchToolMaxResults: Schema.number()
            .min(1)
            .max(60)
            .step(1)
            .description(
                '每次记忆检索最多返回的记忆条数，召回与 living_memory_search 共用。'
            )
            .default(30),
        memorySearchMinSimilarity: Schema.number()
            .min(0)
            .max(1)
            .step(0.05)
            .description(
                '记忆检索的最低余弦相似度，召回与 living_memory_search 共用。关键词命中的记忆不受限制；设为 0 表示不限制。'
            )
            .default(0),
        enableMemoryTools: Schema.boolean()
            .description(
                '向 ChatLuna 注册本插件的记忆工具，包括查询、查看来源、创建、更新和删除工具。'
            )
            .default(false),
        memoryCreateToolMaxMemories: Schema.number()
            .min(1)
            .max(60)
            .step(1)
            .description(
                'living_memory_create_memory 单次调用最多创建的记忆条数。'
            )
            .default(10)
    }).description('工具配置'),
    Schema.object({
        enableAutoDream: Schema.boolean()
            .description('自动执行增量 Dream。')
            .default(false),
        autoDreamMemoryGrowthThreshold: Schema.number()
            .min(10)
            .max(200)
            .step(1)
            .description(
                '未整理的记忆达到该条数时触发自动增量 Dream，每次最多整理该条数的记忆。'
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
                '自动召回与 living_memory_search 只检索当前会话产生的记忆与全局记忆。'
            )
            .default(false),
        recallIntervalMessages: Schema.number()
            .min(0)
            .max(200)
            .step(1)
            .description(
                '每累计该条数的新消息（含 bot 未回复的闲聊）自动召回一次记忆，会话首次对话时立即召回。设为 0 时关闭自动召回。'
            )
            .default(10),
        recallHistoryMessages: Schema.number()
            .min(1)
            .max(200)
            .step(1)
            .description('每次召回取最近该条数的消息作为上下文。')
            .default(20)
    }).description('记忆召回配置'),
    Schema.object({
        extractionWindowMessages: Schema.number()
            .min(0)
            .max(200)
            .step(1)
            .description(
                '未提取的消息累计达到该条数时自动提取一次记忆。设为 0 时关闭自动提取。'
            )
            .default(30),
        extractionIncludeOverheard: Schema.boolean()
            .description(
                '同时提取 bot 未参与的闲聊。关闭时，闲聊只在每次对话前方的提取窗口内提取。'
            )
            .default(false),
        enableExtractionWhitelist: Schema.boolean()
            .description('只对白名单内的会话自动提取记忆。')
            .default(false),
        extractionWhitelist: Schema.array(Schema.string())
            .role('table')
            .description('自动提取白名单：群聊填群号，私聊填对方 QQ 号。')
            .default([])
    }).description('记忆提取配置')
])

export * from './types'
export * from './service/app/living_memory_service'
