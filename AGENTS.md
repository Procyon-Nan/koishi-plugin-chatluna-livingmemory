# chatluna-livingmemory 开发规范

## 项目定位

`chatluna-livingmemory`（npm 包名 `koishi-plugin-chatluna-livingmemory`）是 ChatLuna 生态下的 Koishi 长期记忆插件，位于 `koishi-dev` 工作区的 `external/chatluna-livingmemory`。
本地运行环境由工作区根目录的 Koishi 实例提供。

## 代码文件结构

```text
chatluna-livingmemory/
├── src/
│   ├── index.ts                         # 插件入口、配置 schema 与集成装配
│   ├── query.ts                         # 对外记忆查询接口
│   ├── types.ts                         # 公共契约导出
│   ├── worker_artifacts.ts              # Worker 构建产物定位
│   ├── contracts/
│   │   ├── memory.ts                    # 记忆、来源、快照、画像与任务数据
│   │   ├── workflows.ts                 # 工作流配置、输入输出与服务接口
│   │   ├── vector_index.ts              # 索引文档、查询、变更与状态接口
│   │   └── rpc.ts                       # Console RPC 契约
│   ├── integrations/
│   │   └── koishi-augmentations.ts      # Koishi 服务、事件与 Console 类型合并
│   ├── plugins/
│   │   ├── message_collector.ts         # 消息采集入口
│   │   ├── chat_middleware.ts           # ChatLuna 对话生命周期接入
│   │   ├── character_middleware.ts      # Character 对话生命周期接入
│   │   ├── commands.ts                  # 管理指令
│   │   ├── living_memory_tools.ts       # 主对话记忆工具注册
│   │   └── webui.ts                     # Console 页面与 RPC 注册
│   └── service/
│       ├── app/
│       │   ├── living_memory_service.ts # 应用门面、服务装配与生命周期
│       │   ├── memory_mutation_service.ts # 记忆变更、预设队列与索引同步
│       │   ├── query_projections.ts     # 查询结果组装
│       │   ├── prompt_hydration.ts      # 快照与画像注入
│       │   ├── config_status.ts         # 配置校验与服务状态
│       │   └── scope.ts                 # 预设与会话作用域
│       ├── logging/
│       │   ├── logger.ts                # 工作流日志与诊断事件
│       │   └── model_calls.ts           # 模型请求、响应与用量记录
│       ├── memory/
│       │   ├── entry_fields.ts          # 记忆字段常量与归一化
│       │   ├── speaker_identity.ts      # 用户身份键与昵称映射
│       │   ├── preset_catalog.ts        # 预设目录
│       │   ├── preset_persona.ts        # 人设卡片生成与读取
│       │   ├── helpers.ts               # 角色名称与会话标识辅助函数
│       │   ├── origins/
│       │   │   └── source_origins.ts    # 来源关系构造、归一化与合并
│       │   ├── snapshot/
│       │   │   └── snapshot_text.ts     # 召回快照文本处理
│       │   └── tools/
│       │       ├── index.ts            # 共用工具创建入口
│       │       ├── tool_runtime.ts     # 工具调用作用域解析
│       │       ├── embedding_search_tool.ts # 记忆检索
│       │       ├── get_messages_tool.ts # 来源消息查询
│       │       ├── create_memory_tool.ts # 创建记忆
│       │       ├── update_memory_tool.ts # 更新记忆
│       │       ├── merge_memories_tool.ts # 合并记忆
│       │       ├── split_memory_tool.ts # 拆分记忆
│       │       ├── delete_memory_tool.ts # 归档记忆
│       │       └── checked_memory_tool.ts # 确认记忆无需变动
│       ├── persistence/
│       │   ├── repository.ts            # 持久化门面与串行事务入口
│       │   ├── tables.ts                # Koishi 数据表定义
│       │   ├── types.ts                 # 数据库记录与事务类型
│       │   ├── normalizers.ts           # 数据库记录转换与关联行构造
│       │   ├── entries.ts               # 记忆条目读写、迁移与合并拆分事务
│       │   ├── snapshots.ts             # 召回快照仓库
│       │   ├── jobs.ts                  # 任务记录仓库
│       │   ├── user_profiles.ts         # 用户画像与预设用户仓库
│       │   ├── preset_personas.ts       # 人设卡片仓库
│       │   └── speaker_reconciliation.ts # 预设用户身份核对
│       ├── prompts/
│       │   ├── index.ts                 # 提示词模块导出
│       │   ├── schema.ts                # 模型结构化输出 schema
│       │   ├── memory_tools.ts          # 记忆工具名称、描述与参数 schema
│       │   ├── memory_entries.ts        # 模型记忆字段清单与统一渲染
│       │   ├── prompt_format.ts         # XML 转义与消息组合
│       │   ├── extraction.ts            # 记忆提取提示词
│       │   ├── agentic_recall.ts         # Agentic Recall 提示词
│       │   ├── dream.ts                 # Dream 系统、批次、反馈与摘要提示词
│       │   ├── user_profile.ts          # 用户画像提示词
│       │   └── persona_card.ts          # 人设卡片提示词
│       ├── shared/
│       │   ├── serial_task_queue.ts     # 按键串行任务队列
│       │   └── utils.ts                 # 配置、文本与错误辅助函数
│       ├── transcript/                  # 聊天记录适配、说话人解析与文本渲染
│       │   ├── chatluna_transcript_adapter.ts # ChatLuna 历史适配
│       │   ├── character_transcript_adapter.ts # Character 历史适配
│       │   └── message_log/
│       │       ├── message_log.ts       # 单会话消息日志
│       │       ├── message_log_registry.ts # 日志注册与生命周期
│       │       ├── backfill.ts          # 历史消息回填
│       │       ├── converter.ts         # 日志到模型历史的转换
│       │       ├── element_text.ts      # 消息元素文本化
│       │       └── types.ts             # 消息日志契约
│       ├── vector_index/                # 索引文档、嵌入、变更、维护与状态管理
│       │   ├── service.ts               # 向量索引服务入口
│       │   ├── reconcile.ts             # 主数据库与索引对账
│       │   ├── rebuild.ts               # 索引重建
│       │   ├── worker_client.ts         # Worker 请求与生命周期
│       │   ├── worker_protocol.ts       # 主线程与 Worker 通信契约
│       │   └── worker/
│       │       ├── entry.ts             # Worker 线程入口
│       │       ├── runtime.ts           # Worker 命令执行
│       │       ├── database.ts          # PGlite 数据库启停
│       │       ├── ownership_endpoint.ts # 索引目录所有权
│       │       ├── schema.ts            # pgvector 表与索引定义
│       │       ├── queries.ts           # 向量与关键词查询
│       │       ├── mutations.ts         # 索引事务写入
│       │       └── vector_values.ts     # 向量值转换
│       ├── workflows/
│       │   ├── job_tracker.ts           # 工作流任务状态更新
│       │   ├── structured_output.ts     # 结构化模型调用、校验与纠错
│       │   ├── extraction/
│       │   │   ├── coordinator.ts       # 提取游标、分块与调度
│       │   │   └── extractor.ts         # 模型提取与结果转换
│       │   ├── recall/
│       │   │   ├── coordinator.ts       # 召回间隔、调度与快照保存
│       │   │   ├── agentic_recall.ts    # 召回模型工具循环
│       │   │   ├── embedding_search_engine.ts # 混合检索与重排序
│       │   │   └── indexed_entries.ts  # 索引命中与记忆条目组装
│       │   └── dream/
│       │       ├── coordinator.ts       # Dream 触发、排队与取消
│       │       ├── job_runner.ts        # 任务记录与完成统计
│       │       ├── full.ts              # 全量准备、聚类、会话与画像衔接
│       │       ├── clustering.ts        # 向量快照读取、容量二分与批次组装
│       │       ├── semantic/
│       │       │   ├── types.ts         # 向量矩阵、标签与二分契约
│       │       │   ├── bisect.ts        # 容量约束球面二分
│       │       │   └── validate.ts      # 分组覆盖、计数与容量校验
│       │       ├── partitioning.ts      # 记忆分区入口
│       │       ├── types.ts             # 批次与运行结果类型
│       │       ├── partitioning/        # 初始分区、相似度与分区优化
│       │       ├── hdbscan/             # HDBSCAN 算法与标签整理
│       │       ├── worker/              # Dream Worker 入口、客户端与协议
│       │       └── session/
│       │           ├── runner.ts        # 模型会话循环与工具执行
│       │           ├── history.ts       # 会话历史与上下文压缩
│       │           ├── state.ts         # 批次、处理集合与操作统计
│       │           └── tools.ts         # Dream 工具装配与处理进度衔接
│       └── user_profile.ts              # 用户画像分组、生成与渲染
├── client/
│   ├── index.ts                         # Console 页面与图标注册
│   ├── dashboard.vue                    # 管理页面入口
│   ├── api.ts                           # RPC 调用
│   ├── types.ts                         # 浏览器端契约镜像
│   ├── env.d.ts                         # 浏览器端环境类型
│   ├── components/                      # 记忆、快照、画像、人设、任务与检索组件
│   ├── composables/                     # 分页、选中状态与记忆列表逻辑
│   ├── styles/                          # 页面、组件、主题与 Element Plus 样式
│   ├── icons/                           # 页面图标
│   └── utils/                           # 展示格式与索引状态辅助函数
├── tests/                               # 工作流、工具、持久化、索引与客户端测试
│   ├── vitest-global-setup.ts           # 测试全局初始化
│   ├── persistence-test-utils.ts        # SQLite 测试上下文
│   ├── workflow-test-utils.ts           # 工作流测试数据与桩
│   ├── tool-calling-test-utils.ts       # 模型工具调用测试辅助
│   └── worker-test-utils.ts             # Worker 测试辅助
├── docs/                                # 用户指南、设计方案与验收记录
└── scripts/
    ├── build-workers.mjs                # 构建向量索引与 Dream Worker
    ├── vector-index-benchmark.mjs       # 向量索引基准入口
    ├── vector-index-benchmark-options.mjs # 基准参数
    └── vector-index-benchmark-support.mjs # 基准数据与指标采集
```

新增、删除、移动或重命名目录及本节列出的文件时，同步更新本节。

## 架构规则

1. ChatLuna 与 Character 保持独立接入。
2. 记忆写入经 `LivingMemoryMutationService` 编排。事务经 `LivingMemoryRepository` 串行入口开启，子仓库使用注入的 `transact`。
3. 模型工具经 `createMemoryTool` 创建；调用方选择暴露范围、提供上下文并持有任务状态。
4. 模型输入复用 `renderMemoriesForModel`、`toLogTranscriptMessages` 和 `prompt_format.ts`。字段规则定义在工具参数 schema，结构化输出复用统一校验与纠错入口。
5. WebUI 通过公开 RPC 访问应用服务。
6. RPC 变更同步服务端契约、类型合并、注册和客户端 API、类型、组件。
7. 服务停止时先关闭任务入口，再排空任务并释放资源。可选服务通过 `ctx.inject()` 装配。
8. 日志统一经 `LivingMemoryLogger` 输出。

## 业务文档

| 修改范围 | 文档 |
| --- | --- |
| 身份、会话、消息日志、召回、提取、人设与画像 | [记忆与工作流](docs/memory-workflows.md) |
| Dream 批次、工具进度、上下文压缩与任务状态 | [Dream 会话设计](docs/dream-session-plan.md) |
| Dream 容量二分、HNSW 与跨组修复 | [语义分组实施方案](docs/dream-semantic-batching-implementation.md) |
| 向量索引、目录所有权、重建与就绪状态 | [向量索引](docs/vector-index.md) |
| 模型记忆字段与渲染 | [记忆视图](docs/memory-model-view-plan.md) |
| WebUI 操作 | [WebUI 指南](docs/WEBUI_GUIDE.md) |
| Embedding 与 Reranker 配置 | [模型配置指南](docs/embedding-reranker-guide.md) |

修改业务行为时，同步对应文档。

## 工程原则

1. 注释使用中文，仅记录不直观的约束与原因。
2. Vue 组件保留模板和逻辑，CSS 放在 `client/styles/`，通过 `<style src="...">` 引用。
3. 组件样式使用 `scoped`；Teleport 样式使用受 `lm-*` 类名约束的 `:global()`；`scrollbars.css` 使用非 scoped 引用。公共列表复用 `tab-content.css`。
4. 摒弃一切防御性代码和防御性设计，所有文本描述禁止使用否定表达、与功能无关的多余解释

## 验证要求

所有测试、lint、类型检查、构建和 diff 检查统一在提交版本更新前集中执行；开发过程和普通功能提交阶段不自动运行。

验证范围按自上次版本更新以来的累计变更确定：

| 累计变更范围 | 验证命令 |
| --- | --- |
| 所有版本更新 | `git diff --check` |
| 服务端源码 | `yarn lint`、`yarn test` |
| 契约、持久化或 RPC | `yarn atsc -p tsconfig.json --noEmit` |
| 客户端或 Console | `yarn build:client` |
| 服务端构建、Worker 或包边界 | `yarn build:server`；同时涉及客户端时运行 `yarn build` |

在 WSL 环境下无法执行完整测试时，告知用户并让用户在 Windows 环境执行。
