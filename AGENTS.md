# chatluna-livingmemory 开发规范

## 项目定位

`chatluna-livingmemory`（npm 包名 `koishi-plugin-chatluna-livingmemory`）是 ChatLuna 生态下的 Koishi 长期记忆插件，位于 `koishi-dev` 工作区的 `external/chatluna-livingmemory`。
本地运行环境由工作区根目录的 Koishi 实例提供。

模型供应商适配、ChatLuna 核心会话管理、Character 预设存储与调度、Koishi 数据库驱动和 Console 框架本身都不属于本项目职责。

## 代码文件结构

```text
chatluna-livingmemory/
├── src/
│   ├── contracts/               # 记忆、工作流、向量索引与 RPC 公共契约
│   ├── integrations/            # Koishi 服务、事件与 Console 类型合并
│   ├── plugins/                 # 消息采集器、中间件、管理指令、模型工具与 Console 入口
│   ├── service/
│   │   ├── app/                 # 应用门面、作用域、配置状态与变更编排
│   │   ├── logging/             # 诊断事件与模型调用日志
│   │   ├── memory/              # 记忆字段、来源、speaker、快照和工具实现
│   │   ├── persistence/         # Koishi 表定义、分表仓库与持久化门面
│   │   ├── prompts/             # 工作流提示词、结构化输出 schema 与 XML 格式
│   │   ├── shared/              # 预设队列及少量共享工具
│   │   ├── transcript/          # ChatLuna/Character 聊天记录适配与渲染
│   │   │   └── message_log/     # 会话消息日志、注册表、回填与统一转换
│   │   ├── vector_index/        # PGlite/pgvector 索引服务、重建与 Worker
│   │   ├── workflows/           # extraction、recall、dream 与任务状态
│   │   └── user_profile.ts      # 用户画像分组、生成与渲染
│   ├── index.ts                 # 插件入口、配置 schema 与可选集成装配
│   ├── query.ts                 # 对外查询辅助接口
│   ├── types.ts                 # 公共类型兼容导出
│   └── worker_artifacts.ts      # Worker 构建产物定位
├── client/                      # Console 页面、组件、composable 与契约镜像
├── tests/                       # Vitest 工作流、持久化、集成与客户端测试
├── docs/                        # WebUI 与模型配置用户文档及内部设计备忘
└── scripts/                     # Worker 构建与向量索引基准脚本
```

新增、删除、移动或重命名源码目录、测试目录或脚本目录时，必须在同一次变更中同步更新本节。
目录内新增或重命名单个文件不需要更新。

## 设计约束

1. 预设、会话与身份边界
   - 长期记忆、用户画像和 Dream 任务按 `presetId` 隔离；召回快照按 `presetId + conversationId` 隔离。
   - ChatLuna 预设 ID 保持原值；Character 预设统一经 `toCharacterMemoryPresetId()` 转换，不得在调用点自行拼接后缀。
   - 用户身份是由平台与用户 ID 生成的 `speakerKey`；昵称只是模型可读标签，昵称变化不得产生新身份。
   - 任何把新 `speakerKey` 写上记忆的通道（提取、WebUI 与公共接口的创建和更新、Dream、导入），都必须在预设级队列内补齐 `living_memory_preset_speaker` 的对应行，避免在已清空的预设上写回孤儿行。
     reconcile 对当次对话者的身份注册不受此限。
   - `speakerKeys` 允许为空，表示记忆只与角色自身有关；不得为满足字段形式强行关联当前对话中的用户。

2. ChatLuna 与 Character 集成
   - 两条集成路径的事件载荷、聊天记录适配器、预设标识和注入机制都不同，保持独立，不得合并成统一中间件。
   - ChatLuna 在 `before-chat` 注入当前会话最近一次的快照与用户画像，在 `after-chat` 追加本次实际发出的回复并触发提取。
   - Character 经专用生命周期事件维护上下文，由预设中的 `{living_memory}` 变量注入；不得套用 ChatLuna 的请求级注入方式。
   - 清空会话历史时同步清除快照、召回锚点、提取游标与消息日志，并推进日志纪元，拒绝清空时点之前的回填消息。

3. 聊天记录与 speaker 归属
   - 会话消息日志（`src/service/transcript/message_log/`）是召回与提取共用的唯一历史来源。
     消息角色（user/assistant）在写入时确定，读取方不得重新判定。
   - 日志历史的模型可见转换统一经 `toLogTranscriptMessages`，不得在调用点自行拼装历史视图。
   - 模型可见的说话人与 at 目标统一取用户昵称（`event.user.name` 或 `resolveUserSpeaker`），缺失时退回 userId。
     `author.nick`、`member`、`session.username` 是群名片，不得采信。
   - 非文本消息元素写入日志时替换为占位说明，元素标签的序列化形式不得进入模型可见历史。
     占位提取是同步纯函数，采集与回填共用：渲染与入账不得让出事件循环，因为召回边界与提取分段依赖入账顺序。
   - 模型只返回 `speakerLabels`，服务端按本次聊天记录的昵称映射转换为 `speakerKeys`；模型不得生成或猜测身份键。
   - 来源消息与记忆正文分开保存；查询来源以持久化的来源关系为准，不从正文反推。

4. Recall 工作流
   - Recall 异步执行：当前请求注入已有的快照，本轮新生成的快照只供后续轮次使用，不得阻塞当前模型请求。
   - `recallIntervalMessages` 控制召回间隔，为 0 时关闭。
     会话首次触发立即召回，之后按日志消息条数计算间隔，闲聊同样计入；召回锚点只存在内存中，重启后重新计数，召回失败时清除，下次触发立即重试。
   - 召回上下文为当前触发消息之前的最近 `recallHistoryMessages` 条日志消息。
   - 召回只有 Agentic Recall 一种实现：`subModel` 经召回内部的 `living_memory_search` 检索活跃记忆，快照只保存模型整理后的文本与搜索轨迹，不保存记忆引用。
     不得恢复多策略分派，也不得在协调器内另写检索路径。
   - Reranker 只在 `LivingMemoryEmbeddingSearchEngine` 中接入，召回、主对话工具与 WebUI 检索测试共用这一条路径；重排失败回退混合检索排序，不得阻断检索。
   - 没有可靠结果（含 `<NO_MEMORY>`）时保留既有快照，不以空结果覆盖。
   - 召回失败记录任务与诊断，但不得阻断对话。
     `subModel` 未配置属于配置缺失而非召回失败：入队时跳过，只记诊断、不写任务。
   - 用户关联信息可以说明记忆归属，但不得成为召回门槛。

5. Extraction 工作流
   - 提取按会话日志游标消费：积压达到 `extractionWindowMessages` 时打包提取，为 0 时关闭；同会话串行，跨会话并行。
   - 一次交流（触发消息与其回复）是不可分割的单位，分块不得从中截断。
     唯一例外是旁听模式（`extractionIncludeOverheard`）下超出预算的超长段。
   - 冷启动时游标从当时的日志末尾开始，不重新提取回填的历史。
   - 单块连续失败 3 次后记录 failed job 并跳过该块；未达 3 次则中断本次提取，下次重试。
     不得重复处理已推进游标的消息，也不得在失败后丢弃未消费的消息。
   - `enableExtractionWhitelist` 只限制自动提取，按原始平台 id 匹配（群聊为 `scope.guildId`，私聊为 `scope.userId`）。
     未命中的会话不初始化游标，消息日志、召回、注入与主动创建工具不受影响。
   - 模型输出经结构化结果工具校验后才能写入，格式错误走统一纠错流程，不得另写解析或兜底。

6. Dream 与用户画像
   - Dream 只处理活跃记忆，归档记忆不参与聚类、邻居查询、整理或画像生成。
   - 预设活跃记忆少于 30 条时两种触发都不启动：手动触发返回 `insufficient-memories`，自动触发只记跳过日志。
   - `archive` 归档活跃记忆；`merge` 必须经 `applyDreamMerge()` 原子完成，不得拆成多个独立写操作。
   - update 与 merge 完整覆盖 `speakerKeys` 和其余可变字段，不与旧关联用户取并集。
   - 每个整理单元的模型结果必须用恰好一个操作覆盖单元内每条记忆（无需改动的用 `keep`），覆盖校验在落库前执行。
     不达标走纠错重试，仍失败则该单元记为失败，不推进其记忆的固化。
   - 同一任务内已处理过的记忆不得被再次操作；同一预设的 Dream 任务串行执行。
   - 全量 Dream 的聚类交给 Dream Worker；增量 Dream 只处理待整理批次及其邻居，不得扩大为全库扫描。
   - 用户画像只在 Dream 内生成（全量与增量均是），生成与注入受 `enableUserProfileInjection` 控制；speaker 发现与该开关无关。
     WebUI 手工编辑的画像仍可被后续 Dream 覆盖。

7. 模型工具、提示词与结构化输出
   - `src/service/prompts/` 是提示词与 Zod schema 的唯一来源；字段说明放在结果工具参数描述中，不在提示词正文重复。
   - 送入模型的记忆视图统一经 `renderMemoriesForModel` 渲染。
     只有模型需要引用记忆时才渲染 ID：主对话的 `living_memory_search` 渲染，Agentic Recall 与用户画像不渲染。
   - 动态文本经 `prompt_format.ts` 转义并组合为 System/Human 消息，不得在工作流中复制 XML 拼接或转义。
   - 结构化结果工具是单次调用内部工具，其 schema、提示词规则、校验、纠错次数与工作流失败处理必须一致。
   - 提取、Dream 与用户画像的角色人设统一取预设人设卡片（`preset_persona.ts`），不注入预设原文；recall 不使用人设。
     - 卡片原文取预设 system 部分的未渲染模板，模型只选择要删除的行，保留部分与原文逐字节一致，不重写正文。
     - 落库行是卡片的唯一状态，卡片服务是唯一写入方，不设内存缓存；工作流经 `resolve(presetId)` 取卡片，按原文哈希懒更新。
     - 写入在按预设串行的队列内重读后落库，不覆盖期间保存的手工卡片，清空预设数据后不写回。
     - 手工卡片（`source='manual'`）不随预设变动自动覆盖；清空预设数据时一并删除。
     - 外部插件只有只读接口 `resolvePresetPersona` 与 `getPresetPersonaCard`，前者在无卡片时返回原文，不调模型、不落库。
   - 用户画像结果为 `update` 或 `keep`，均须填写理由；尚无画像时 `keep` 被拒绝并走纠错重试。
     `keep` 不改写正文，但记下本次输入，输入未变的后续 Dream 跳过该用户。
   - `living_memory_get_messages` 按 `living_memory_search` 返回的 ID 查看来源消息；主动创建工具允许 speaker 关联为空。
   - Agentic Recall 的工具参数持续出错达到上限时直接终止，不再额外发起 finalization 调用。

8. 持久化、变更与缓存一致性
   - `src/service/persistence/` 负责表定义与表级仓库，`LivingMemoryRepository` 是上层门面；工作流不得直接操作数据库表。
   - 多语句写入的中间状态对并发读者非法时必须使用事务；不满足该条件的多语句写入须在代码中写明依据。
   - 事务只能经 `LivingMemoryRepository` 的串行入口开启，子模块通过构造注入的 `transact` 取得句柄，不得直接调用 `ctx.database.transact` 或 `withTransaction`：单连接数据库无法并发开启事务。
   - `living_memory_entry.speakerKeys` 是用户关联事实，`living_memory_entry_speaker` 只索引活跃记忆。
     `status` 或 `speakerKeys` 变更必须与关联行重写在同一事务内；不得增加独立计数字段或为归档记忆保留关联行。
   - schema 变更须同步公共契约、表定义、normalizer、仓库、迁移兼容与受影响的 RPC/客户端类型。
   - embedding 只由正文生成：正文变化时必须重新生成，其余字段变化（含状态）保留向量。
     任何字段变化都须同步索引文档，关键词索引随之重写。
   - 快照注入每次直接读取持久化的最新快照，不设内存缓存：快照由召回直接落库、也会被迁移与清理路径直接删除，缓存失效无法集中保证。
   - 管理指令的 text/user 删除只匹配活跃记忆并执行归档，profile 删除只删目标画像；所有删除保留 60 秒确认。

9. 向量索引与 Worker 生命周期
   - PGlite/pgvector 是派生索引，Koishi 主数据库是记忆事实来源，索引必须能据此 reconcile 或 rebuild。
   - PGlite 连接与目录所有权由同一个 Worker 持有：先取得所有权再打开数据库，先关闭数据库再释放所有权；重建切换目录期间不得出现无所有权窗口。
   - 所有权只保证同机进程互斥，不支持多进程共享运行中的索引目录。
     端点为 Windows 命名管道或 Linux 抽象 Unix Socket，标识取规范化目录的稳定哈希；不得重新引入锁文件、PID、mtime、心跳或 `fs-native-extensions`。
   - 服务停止时先停止接收新操作，再排空在途操作并等待 Worker 退出，关闭失败才终止；新 HMR generation 必须等旧 generation 的 Worker 结束后再启动。
   - 模型的 `living_memory_search` 工具统一只查活跃记忆，不暴露状态参数；主对话、召回内部检索与 Dream 邻居查询均固定只查活跃。归档记忆供人工查看，底层索引保留按 `memoryStatus` 查询的能力。
     归档向量照常维护，重新激活时直接复用。
   - 预设状态账本（`lm_index_preset_state`）只落盘终态 `ready`/`dirty`，`building`、`unavailable` 等瞬态只存在于主进程，不得持久化。
     账本行存在当且仅当该预设存在于 DB 条目或索引文档中，孤儿行由全量对账清除。
   - 就绪门禁按预设独立判定：只有索引级条件（manifest 未建立、全局维护窗口、Worker 故障）拦截全部读取，单个预设未就绪不得阻断其他预设。

10. WebUI 与 RPC
    - Console RPC 变更须同步 `src/contracts/rpc.ts`、Koishi declaration merging、`src/plugins/webui.ts`、`client/api.ts`、`client/types.ts` 与受影响的组件。
    - 浏览器侧不得导入仅服务端可运行的模块，共享数据形状使用浏览器安全的契约镜像。
    - 分页、选中状态与弹窗编辑复用现有 composable 与组件，不在页面中复制资源加载与变更逻辑。
    - WebUI 的所有数据操作一律调用公开 RPC，不绕过应用服务直接访问数据库或索引。

11. Koishi 生命周期与后台任务
    - 必需服务为 `chatluna` 与 `database`；`console` 与 `chatluna_character` 只在各自的 `ctx.inject()` 片段中装配。
    - 后台工作流保持非阻塞，保留既有的任务记录与错误日志。
    - 定时器、事件监听、Worker 与缓存必须绑定插件生命周期；dispose 后不得接受新的数据库、索引或模型任务。
    - 日志统一经 `LivingMemoryLogger` 或 Koishi logger 输出。

## 工程原则

1. TypeScript ESM 风格以 `.oxfmtrc.json` 与 `.oxlintrc.json` 为准。
2. 注释只解释不直观的约束或原因，使用中文，不添加复述代码的注释。
3. `lib/` 与 `dist/` 是生成产物，除非任务明确要求，不得手工编辑。

## 验证要求

1. 仅文档变更：运行 `git diff --check`。
2. 服务端源码变更：运行 `yarn lint`（oxlint 加 `oxfmt --check`）、`yarn test` 与 `git diff --check`。
3. 契约、持久化或 RPC 变更：另运行 `yarn atsc -p tsconfig.json --noEmit`。
4. 客户端或 Console 变更：另运行 `yarn build:client`。
5. 服务端构建、Worker 或包边界变更：运行 `yarn build:server`；同时涉及客户端时运行完整 `yarn build`。

在 WSL 环境下无法执行完整测试，需要 Windows 环境执行。
