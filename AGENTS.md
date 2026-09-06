# chatluna-livingmemory 开发规范

## 项目定位

`chatluna-livingmemory`（npm 包名
`koishi-plugin-chatluna-livingmemory`）是 ChatLuna 生态下的 Koishi 长期记忆
插件，位于 `koishi-dev` 工作区的 `external/chatluna-livingmemory`。本地运行
环境由工作区根目录的 Koishi 实例提供。

模型供应商适配、ChatLuna 核心会话管理、Character 预设存储与调度、Koishi
数据库驱动和 Console 框架本身都不属于本项目职责。

## 代码文件结构

```text
chatluna-livingmemory/
├── src/
│   ├── contracts/               # 记忆、工作流、向量索引与 RPC 公共契约
│   ├── integrations/            # Koishi 服务、事件与 Console 类型合并
│   ├── plugins/                 # 中间件、管理指令、模型工具与 Console 入口
│   ├── service/
│   │   ├── app/                 # 应用门面、作用域、配置状态与变更编排
│   │   ├── logging/             # 诊断事件与模型调用日志
│   │   ├── memory/              # 记忆字段、来源、speaker、快照和工具实现
│   │   ├── persistence/         # Koishi 表定义、分表仓库与持久化门面
│   │   ├── prompts/             # 工作流提示词、结构化输出 schema 与 XML 格式
│   │   ├── shared/              # 预设队列、轮次及少量共享工具
│   │   ├── transcript/          # ChatLuna/Character 聊天记录适配与渲染
│   │   ├── vector_index/        # PGlite/pgvector 索引服务、重建与 Worker
│   │   ├── workflows/           # extraction、recall、dream 与任务状态
│   │   └── user_profile.ts      # 用户画像分组、生成与渲染
│   ├── index.ts                 # 插件入口、配置 schema 与可选集成装配
│   ├── query.ts                 # 对外查询辅助接口
│   ├── types.ts                 # 公共类型兼容导出
│   └── worker_artifacts.ts      # Worker 构建产物定位
├── client/                      # Console 页面、组件、composable 与契约镜像
├── tests/                       # Vitest 工作流、持久化、集成与客户端测试
├── docs/                        # WebUI 与模型配置用户文档
└── scripts/                     # Worker 构建与向量索引基准脚本
```

新增、删除、移动或重命名源码目录、测试目录或脚本目录时，必须在同一次变更中
同步更新本节。目录内新增或重命名单个文件不需要更新。

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
   - `enableExtractionWhitelist` 开启时只有白名单会话进入提取：群聊比对
     `scope.guildId`，私聊比对 `scope.userId`，均为原始平台 id。未命中的会话在
     进入轮次缓冲前返回，不累计轮次；白名单只约束自动提取，召回、快照与画像
     注入以及 `living_memory_create_memory` 不受其影响。
   - 提取必须取得对应预设提示词，并使用本次聊天记录附带的 speaker 映射。
   - 模型输出经结构化结果工具校验后才能写入；模型格式错误遵循统一纠错
     流程，不得在 Extraction 内另写一套解析或兜底。

6. Dream 与用户画像
   - Dream 只处理活跃记忆。归档记忆不参与聚类、增量邻居查询、整理或用户
     画像生成。
   - 预设活跃记忆少于一个整理单元（30 条）时两种触发都不启动任务：手动触发
     返回 `insufficient-memories` 供 WebUI 提示，自动触发只写跳过日志。用户
     画像只在 Dream 内生成，该门槛同时推迟小预设的画像生成。
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
   - 送入模型阅读的记忆视图由 `prompts/memory_entries.ts` 的
     `renderMemoriesForModel` 统一渲染，各工作流不得自行拼装记忆视图。记忆 ID
     只在模型需要引用记忆时渲染：`living_memory_search` 渲染 ID 供
     `living_memory_get_messages` 使用，Agentic Recall 与用户画像不渲染 ID。
   - 用户画像提示词在记忆列表前说明关联记忆总数与实际送入条数；画像输出只有
     正文，没有操作引用记忆 ID，送入的记忆也一律等权使用。
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
   - 所有权只保证遵循本插件协议的同机进程互斥，不支持多进程共享同一个运行中
     的索引目录。
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

1. TypeScript ESM 风格以 `.oxfmtrc.json` 与 `.oxlintrc.json` 为准。
2. 注释只解释不直观的约束或原因，使用中文，不添加复述代码的注释。
3. `lib/` 与 `dist/` 是生成产物，除非任务明确要求，不得手工编辑。

## 验证要求

1. 仅文档变更：运行 `git diff --check`。
2. 服务端源码变更：运行 `yarn lint` 与 `git diff --check`。
3. 契约、持久化或 RPC 变更：另运行
   `yarn atsc -p tsconfig.json --noEmit`。
4. 客户端或 Console 变更：另运行 `yarn build:client`。
5. 服务端构建、Worker 或包边界变更：运行 `yarn build:server`；同时涉及客户
   端时运行完整 `yarn build`。构建脚本依赖 win32-only 二进制，在 WSL 下无法
   执行，此时如实说明该级验证未完成。
