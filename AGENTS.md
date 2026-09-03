# chatluna-livingmemory 开发规范

## 项目定位

`chatluna-livingmemory`（npm 包名
`koishi-plugin-chatluna-livingmemory`）是 ChatLuna 生态下的 Koishi 长期记忆
插件，位于 `koishi-dev` 工作区的 `external/chatluna-livingmemory`。本地运行
环境由工作区根目录的 Koishi 实例提供。

本项目负责将 ChatLuna 与 Character 对话转换为长期记忆，完成记忆提取、
召回、Dream 整理、用户画像、持久化向量索引、管理指令和 Console WebUI。
长期记忆按预设隔离；召回快照在预设隔离的基础上继续按会话隔离。

本项目不承载以下职责：

1. 模型供应商适配、通用模型调用基础设施与 ChatLuna 核心会话管理。
2. Character 预设的存储、会话调度与基础提示词渲染。
3. Koishi 数据库驱动和 Console 框架本身的实现。
4. 多进程共享同一个运行中 PGlite 索引目录；向量索引所有权只保证遵循
   本插件协议的同机进程互斥。

## 代码文件结构

以下结构只列出需要维护的源码和工程文件；`node_modules/`、`lib/`、
`dist/`、`tmp/`、`.codegraph/` 等依赖、构建产物、索引或临时目录不属于
代码结构。

```text
chatluna-livingmemory/
├── src/
│   ├── contracts/                       # 记忆、工作流、向量索引与 RPC 公共契约
│   ├── integrations/
│   │   └── koishi-augmentations.ts      # Koishi 服务、事件与 Console 类型合并
│   ├── plugins/
│   │   ├── character_middleware.ts      # Character 生命周期、快照/画像注入与提取接线
│   │   ├── chat_middleware.ts           # ChatLuna before/after-chat 接线与会话清理
│   │   ├── commands.ts                  # livingmemory 管理指令与删除确认流程
│   │   ├── living_memory_tools.ts       # 模型查询、原文读取与主动创建工具注册
│   │   └── webui.ts                     # Console 入口与 RPC 监听器
│   ├── service/
│   │   ├── app/                         # 应用门面、作用域、配置状态与变更编排
│   │   ├── logging/                     # 诊断事件与模型调用日志
│   │   ├── memory/                      # 记忆字段、来源、speaker、快照和工具实现
│   │   ├── persistence/                 # Koishi 表定义、分表仓库与持久化门面
│   │   ├── prompts/                     # 工作流提示词、结构化输出 schema 与 XML 格式
│   │   ├── shared/                      # 预设队列、轮次及少量共享工具
│   │   ├── transcript/                  # ChatLuna/Character 聊天记录适配与渲染
│   │   ├── vector_index/                # PGlite/pgvector 索引服务、重建与 Worker 协议
│   │   │   ├── worker/                  # PGlite 连接、查询、变更、schema 与所有权端点
│   │   │   └── worker_protocol.ts       # 主线程与向量索引 Worker 的消息契约
│   │   ├── workflows/
│   │   │   ├── dream/                   # 聚类、增量整理、动作执行与 Dream Worker
│   │   │   ├── extraction/              # 对话轮次缓冲与记忆提取
│   │   │   ├── recall/                  # embedding-rerank 与 agentic-recall
│   │   │   ├── job_tracker.ts           # 后台工作流任务状态
│   │   │   └── structured_output.ts     # 调用级结果工具、校验与纠错
│   │   └── user_profile.ts              # 用户画像分组、生成与渲染
│   ├── index.ts                         # 插件入口、配置 schema 与可选集成装配
│   ├── query.ts                         # 对外查询辅助接口
│   ├── types.ts                         # 公共类型兼容导出
│   └── worker_artifacts.ts              # Worker 构建产物定位
├── client/
│   ├── components/                      # 记忆、画像、快照、任务与检索测试界面
│   ├── composables/                     # 分页资源、选择状态与记忆列表状态
│   ├── styles/                          # Dashboard 与弹窗的分域样式
│   ├── api.ts                           # Console RPC 客户端
│   ├── dashboard.vue                    # Living Memory 主页面
│   ├── index.ts                         # Console 客户端入口
│   └── types.ts                         # 浏览器侧 RPC 与展示契约镜像
├── tests/                               # Vitest 工作流、持久化、集成与客户端测试
├── docs/                                # WebUI 与模型配置用户文档
├── .github/
│   └── workflows/
│       └── publish.yml                  # 包版本变更后的 npm 自动构建与发布
├── scripts/
│   ├── build-workers.mjs                # 构建向量索引与 Dream Worker
│   └── vector-index-benchmark*.mjs      # 向量索引基准脚本及支持代码
├── .oxfmtrc.json                        # oxfmt 格式配置
├── .oxlintrc.json                       # oxlint 静态检查配置
├── AGENTS.md                            # 项目结构与开发规范
├── CHANGELOG.md                         # 版本变更记录
├── README.md                            # 面向用户的功能与使用说明
├── package.json                         # 包元数据、依赖与工程脚本
├── package-lock.json                    # 独立仓库 CI 使用的 npm 依赖锁定
├── tsconfig.json                        # 服务端 TypeScript 配置
├── vitest.config.ts                     # Vitest 配置
└── yakumo.yml                           # yakumo 构建配置
```

新增、删除、移动或重命名源码目录、主要模块、测试目录、脚本目录或工程配置
文件时，必须在同一次变更中同步更新本节。不得提交与实际仓库结构不一致的
说明。

## 设计约束

1. 预设、会话与身份边界
   - 长期记忆、用户画像和 Dream 任务按 `presetId` 隔离；召回快照按
     `presetId + conversationId` 隔离。
   - ChatLuna 预设 ID 保持原值；Character 预设统一经
     `toCharacterMemoryPresetId()` 转换。不得在调用点自行拼接 Character
     后缀。
   - 用户关联使用稳定 `speakerKey`，由平台与用户 ID 生成；昵称只作为
     模型可读标签。昵称变化不得产生新的用户身份。
   - `speakerKeys` 允许为空，表示记忆只与角色自身有关；不得为了满足字段
     形式强行关联当前对话中的用户。

2. ChatLuna 与 Character 集成
   - 两条集成路径保持独立。它们使用不同事件载荷、聊天记录适配器、预设
     标识和注入机制，不得为表面复用合并成统一中间件。
   - ChatLuna 通过 `before-chat` 注入已缓存快照与用户画像，通过
     `after-chat` 提交完成轮次供 Extraction 使用。
   - Character 通过专用生命周期事件维护上下文，并由预设中的
     `{living_memory}` 变量注入；不得套用 ChatLuna 的请求级注入方式。
   - 清空会话历史时同步清除对应快照、提取缓冲和内存召回计数。

3. 聊天记录与 speaker 归属
   - ChatLuna 与 Character 原始消息只经各自 transcript adapter 转换，公共
     渲染和轮次裁剪复用 `src/service/transcript/` 内的实现。
   - 模型可见聊天记录统一使用规范化昵称，并用 `<chat_history>` 包裹；存在
     独立末条消息时使用 `<last_message>`。
   - Extraction 返回 `speakerLabels`，服务端只根据本次 transcript 中建立的
     昵称映射转换为 `speakerKeys`。模型不得直接生成或猜测稳定身份键。
   - 来源消息序列化与记忆正文分开保存；查询原始消息时以持久化来源关系为
     准，不从记忆正文反推。

4. Recall 工作流
   - Recall 是异步流程。当前请求注入开始前已水合的快照；本轮新生成的快照
     只供后续轮次使用，不得改成阻塞当前模型请求。
   - 自动召回计数只存在内存中，并按预设会话隔离。启用时首次立即召回，
     此后按 `recallInterval` 轮次执行；插件或相关集成重启后重新计数。
   - `embedding-rerank` 只从活跃记忆中检索，快照保存记忆引用；
     `agentic-recall` 保存模型整理后的文本和搜索轨迹。
   - 没有可靠结果时保留既有快照，不以空结果覆盖。召回失败记录任务和诊断
     信息，但不得阻断正常对话。
   - 用户关联信息可用于说明记忆归属，但不得成为召回门槛。

5. Extraction 工作流
   - Extraction 以已完成的用户/助手轮次为输入，保留按作用域的内存缓冲、
     串行执行和触发边界消费语义。
   - `extractionInterval = 0` 时关闭自动提取；触发时只消费已达到边界的轮次，
     不得重复处理或在失败后错误丢弃未消费轮次。
   - 提取必须取得对应预设提示词，并使用本次聊天记录附带的 speaker 映射。
   - 模型输出经结构化结果工具校验后才能写入；模型格式错误遵循统一纠错
     流程，不得在 Extraction 内另写一套解析或兜底。

6. Dream 与用户画像
   - Dream 只处理活跃记忆。归档记忆不参与聚类、增量邻居查询、整理或用户
     画像生成。
   - `archive` 可将当前活跃记忆归档；`merge` 原子更新目标记忆并归档来源
     记忆。合并必须通过 `applyDreamMerge()` 完成，不得拆成多个独立写操作。
   - Dream 的 update 与 merge 结果完整覆盖模型生成的 `speakerKeys` 和其余
     可变字段，不对旧关联用户做并集保留。
   - 保留阶段动作白名单、单次任务 touched-memory 防重复处理、完整生成元
     数据和预设级任务串行约束。
   - 全量 Dream 的聚类与 HDBSCAN 计算交给 Dream Worker；增量 Dream 只处理
     pending 批次及其已 consolidation 邻居，不得扩大为无界全库扫描。
   - 用户画像生成和注入受 `enableUserProfileInjection` 控制；speaker 发现与
     画像开关无关。WebUI 手工编辑画像后，后续 Dream 仍可覆盖画像内容。

7. 模型工具、提示词与结构化输出
   - `src/service/prompts/` 是工作流提示词和 Zod schema 的唯一来源；字段说明
     优先放在结果工具参数描述中，不在 prompt 正文重复维护。
   - 动态文本经 `prompt_format.ts` 负责的 XML 块转义和 System/Human 消息
     组合进入模型。不得在各工作流中复制 XML 拼接或转义逻辑。
   - 结构化结果工具是单次调用内部工具。工具 schema、提示词规则、校验、
     纠错次数和工作流失败处理必须保持一致。
   - `living_memory_search` 只查询活跃记忆；`living_memory_get_messages` 根据
     已返回的记忆 ID 全量返回其来源消息；主动创建工具允许 speaker 关联为空。
   - Agentic Recall 在找不到相关记忆时输出 `<NO_MEMORY>`；解析到该结果时不
     更新快照。工具参数持续错误达到上限时直接终止本次召回，不再发起额外
     finalization 调用。

8. 持久化、变更与缓存一致性
   - `src/service/persistence/` 负责表定义和表级仓库，
     `LivingMemoryRepository` 是上层持久化门面。工作流不得直接操作 Koishi
     数据库表。
   - 一次逻辑写入需要多于一条语句、且中间状态对并发读者非法时必须使用事务；
     单语句写入本身原子，不需要事务。不满足事务条件的多语句写入必须在代码中
     写明依据。
   - 事务只能通过 `LivingMemoryRepository` 的串行入口开启。持久化子模块通过
     构造注入的 `transact` 取得事务句柄，不得直接调用 `ctx.database.transact`
     或 `withTransaction`。单连接数据库无法并发开启事务，绕过该入口的失效方式
     是死锁或索引漂移，类型检查和测试都不会暴露。
   - `living_memory_entry.speakerKeys` 是用户关联事实；
     `living_memory_entry_speaker` 只索引活跃记忆。`status` 或 `speakerKeys`
     变更必须与关联行重写在同一事务内提交。不得增加独立计数字段或为归档记忆
     保留关联行。
   - schema 变更必须同步更新公共契约、表定义、normalizer、仓库、迁移兼容
     和受影响的 RPC/客户端类型。
   - 记忆正文、摘要或关键词变化时必须使旧 embedding 失效并安排索引同步；
     仅状态变化时保留可复用向量。
   - 快照内容变化、记忆删除或会话清理必须清除对应 snapshot cache。不得让
     内存缓存继续暴露已经失效的数据库状态。
   - 管理指令的 text/user 删除只匹配活跃记忆，确认后执行归档；profile
     删除只删除目标画像。所有删除操作保留 60 秒明确确认流程。

9. 向量索引与 Worker 生命周期
   - PGlite/pgvector 是持久化向量索引；Koishi 主数据库仍是记忆事实来源，
     向量索引必须能够据此 reconcile 或 rebuild。
   - PGlite 连接和目录所有权端点由同一个向量索引 Worker 持有。Worker 先
     取得所有权再打开数据库，关闭时先关闭 PGlite 再释放所有权。
   - Windows 使用命名管道、Linux 使用抽象 Unix Socket，以规范化目录的
     稳定哈希作为端点标识；不得重新引入锁文件、PID、mtime、心跳或
     `fs-native-extensions`。
   - 重建期间同一个 Worker 持续持有活动目录所有权；关闭当前连接、切换
     目录并重新打开的过程不得产生无所有权窗口。
   - 服务停止时先停止接收新操作，再排空在途操作并等待 Worker 完整退出；
     关闭失败时才终止 Worker。新 HMR generation 必须等待旧 generation 的
     Worker 结束后启动。
   - 索引查询只返回活跃记忆。归档向量可保留，以便 WebUI 重新激活记忆时
     复用，但不得提供归档向量检索入口。

10. WebUI 与 RPC
   - Console RPC 变更必须同步更新 `src/contracts/rpc.ts`、Koishi declaration
     merging、`src/plugins/webui.ts`、`client/api.ts`、`client/types.ts` 和受
     影响的 Vue 状态或组件。
   - 浏览器侧不得直接导入仅服务端可运行的模块；共享数据形状使用浏览器
     安全的契约镜像。
   - 分页、选中状态和弹窗编辑复用现有 composable 与组件边界，不在页面中
     复制资源加载和变更逻辑。
   - WebUI 的编辑、删除、导入导出、Dream、索引维护操作一律调用公开 RPC，
     不绕过应用服务直接访问数据库或索引。

11. Koishi 生命周期与后台任务
   - 必需服务为 `chatluna` 与 `database`；`console` 和
     `chatluna_character` 仅在各自 `ctx.inject()` 片段中装配。
   - 后台工作流保持非阻塞，并保留既有任务记录、错误日志和审计语义。
   - 定时器、事件监听、Worker 和缓存必须绑定插件生命周期；dispose 后不得
     接受新的数据库、索引或模型任务。
   - 日志统一经 `LivingMemoryLogger` 或 Koishi logger 输出。`debug` 会记录
     完整对话、预设提示词和记忆正文，只能用于访问受控环境。

## 工程原则

1. 遵循本仓库现有 TypeScript ESM 风格：无分号、单引号、无尾逗号、
   4 空格缩进、80 列，具体以 `.oxfmtrc.json` 与 `.oxlintrc.json` 为准。
2. 所有文本文件统一使用 LF 换行。
3. 变更保持最小范围。优先改善现有接口和职责，不为单一调用创建多层包装、
   兼容链或推测性 fallback。
4. 复用 transcript adapter、prompt helper、字段 normalizer、工具契约、预设
   队列和仓库能力；只有存在真实共享契约时才提取公共抽象。
5. 不确定 Koishi、ChatLuna、Character、PGlite 或模型工具行为时，先核对本地
   源码、类型或官方文档，不得凭经验猜测。
6. 错误处理保留足够上下文和既有失败语义，不静默吞掉异常，也不把底层原始
   错误直接暴露给最终用户。
7. 注释只解释不直观的约束或原因；复杂说明使用中文，不添加复述代码的注释。
8. `lib/` 与 `dist/` 是生成产物，除非任务明确要求，不得手工编辑。
9. 每项代码变更记录在 `CHANGELOG.md`，未提交时使用 `pending`，并随下一次
   版本更新将其替换为真实短提交哈希；不得伪造提交哈希。

## 验证要求

1. 仅文档变更：运行 `git diff --check`。
2. 服务端源码变更：运行 `yarn lint` 与 `git diff --check`。
3. 契约、持久化或 RPC 变更：另运行
   `yarn atsc -p tsconfig.json --noEmit`。
4. 客户端或 Console 变更：另运行 `yarn build:client`。
5. 服务端构建、Worker 或包边界变更：运行 `yarn build:server`；同时涉及客户
   端时运行完整 `yarn build`。
6. 只在变更影响既有测试契约时调整相关测试；除非任务明确要求，不为简单
   变更新增专项测试或扩大验证范围。
7. 自动化检查只证明源码、类型和构建层结果，不得表述为真实 Koishi、模型
   供应商或跨平台运行验收。

## 发布流程

1. `main` 分支的 `package.json` 变更由
   `.github/workflows/publish.yml` 触发自动发布；工作流自身变更也会触发一次，
   并支持从 GitHub Actions 手工运行。
2. 发布前先查询 npm 是否已存在当前 `name + version`。版本已存在时正常跳过，
   不重复执行安装、构建或发布。
3. 发布环境使用 GitHub 托管的 Ubuntu Runner、Node 24 和 `npm ci`，随后运行
   `npm run build` 与 `npm publish --access public`。
4. npm 认证只使用 Trusted Publisher 提供的 OIDC 临时凭据。工作流必须保留
   `id-token: write`，不得提交 npm token 或在日志中输出认证信息。
5. npm 包的 Trusted Publisher 必须绑定仓库
   `Procyon-Nan/koishi-plugin-chatluna-livingmemory` 与工作流文件
   `publish.yml`。修改工作流文件名时必须同步更新 npm 侧配置。

## CodeGraph

仓库存在 `.codegraph/`。定位源码、分析调用路径和评估影响范围时，应先使用
CodeGraph，再按需读取文件或使用 `rg`。常用入口包括 `src/index.ts`、
`ChatLunaLivingMemoryService`、ChatLuna/Character 中间件、Recall、Extraction、
Dream、`LivingMemoryRepository`、向量索引 Worker 和 `src/plugins/webui.ts`。
