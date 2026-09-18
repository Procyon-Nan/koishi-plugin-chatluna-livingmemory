# 可选会话隔离执行方案

日期：2026-09-17。状态：已实现并完成本地验证；真实聊天环境待验收。

## 已确认决策

- 新增 `enableConversationIsolation`，默认关闭。
- 开启后，两种召回策略和对话中的 `living_memory_search` 只检索同预设内的活跃记忆，且来源会话等于当前会话或为 `null`。
- 用户画像继续以用户为核心；Dream、`living_memory_get_messages`、旧快照和管理操作沿用现有行为。子代理不纳入支持范围。
- 管理页面复用已有 `sourceLabel` 展示，不新增会话筛选或管理权限限制。
- 来源会话作为向量索引元数据，在语义与关键词查询内部过滤，再排序、截取候选。字段不参与 embedding 计算。
- 旧索引原地加列并补齐来源，保留已有向量；补齐之前不开放检索。

## 实施步骤与进度

- [x] 调研并确认范围、过滤位置和索引升级方式。
- [x] 增加配置，贯通普通搜索与两种召回策略的会话信息。
- [x] 贯通索引源记录、文档、Worker 协议、清单、写入与对账中的来源字段。
- [x] 增加索引 v3 → v4 定向事务迁移，复用启动对账补齐来源。
- [x] 在语义与关键词查询中应用相同的来源条件，保留管理与 Dream 查询范围。
- [x] 更新用户文档、历史会话键备忘与 CHANGELOG。
- [x] 完成静态检查、构建、既有相关测试和临时索引验收，记录结果。

## 1. 配置与接口约定

在 `src/contracts/workflows.ts` 的 `LivingMemoryConfig` 和 `src/index.ts` 的召回配置组中增加 `enableConversationIsolation: boolean`，schema 默认值为 `false`。

读取配置的位置限于对话搜索工具与 Recall 协调入口。底层搜索引擎和向量索引只接收明确的查询条件，不自行读取插件开关，保证 WebUI 和 Dream 能继续调用同一底层实现。

接口调整：

| 接口 | 调整与含义 |
| --- | --- |
| `LivingMemorySearchProvider.searchMemories` | 增加第三个参数 `conversationId?: string`；传入字符串时限定当前会话及全局记忆，不传时不增加会话条件 |
| 应用门面的 `searchMemories` | 接收并转发第三个参数，不影响原有两参数调用 |
| 搜索引擎的 `searchMemories` / `searchMemoriesDetailed` | 接收同一参数，传入 `searchHybrid` |
| `LivingMemoryRetriever.retrieve` | 在现有 logger 参数后增加可选 `conversationId`，传入 `searchSemantic` |
| `MemorySemanticSearchInput` / `VectorIndexFilter` | 增加 `conversationId?: string`；Hybrid 查询继承该条件 |
| 索引记录的 `sourceConversationId` | 必填 `string \| null`；这里的 null 表示记忆全局可见，与查询参数缺省表示“不限制来源”区分 |

模型的 Zod 搜索参数不增加会话字段；Console RPC 不增加参数。本轮不会让模型选择或改写查询作用域。

## 2. 三条调用路径如何传递会话

### 2.1 对话中的 living_memory_search

涉及 `src/plugins/living_memory_tools.ts`、`src/service/memory/tools/embedding_search_tool.ts` 和已有的 `tool_runtime.ts`。

- 注册搜索工具时把隔离开关传给 `LivingMemorySearchTool`。
- 关闭时沿用现有预设解析，不要求额外上下文。
- 开启时复用 `resolveToolMemoryScopeConfigurable`：ChatLuna 取 `agentContext.conversationId`；Character 用既有 helper 从 session 计算 `group:{guildId}` 或 `private:{userId}`。
- 将解析出的会话作为第三个内部参数传给搜索服务。保持原有错误处理，不增加子代理追溯或上下文降级分支。

### 2.2 embedding-rerank 自动召回

在 `src/service/workflows/recall/coordinator.ts` 的 `runEmbeddingRerank` 中按开关决定是否传递 `scope.conversationId`。`retriever.ts` 把条件交给向量检索，在 reranker 读取候选之前完成过滤。

调用顺序：`scope → coordinator → retriever → searchSemantic → queryKnn`。

### 2.3 Agentic Recall 自动召回

在 `src/service/workflows/recall/agentic_recall.ts` 内部搜索工具上使用同一个开关。该流程已有完整 scope，但当前内部 `agentContext` 只有 requestId；把 `scope.conversationId` 放入它使用的 `agentContext`，替代无人消费的扁平 conversationId。

内部 preset 已是规范化的 `scope.presetId`，直接使用，不再按 Character 追加后缀。这里传递的是明确的内部作用域，不依赖外部 session 重建。

调用顺序：`scope → 内部搜索工具 → searchMemories → searchHybrid → queryHybrid`。

### 2.4 管理和 Dream 调用

WebUI 的 `searchMemoriesDetailed(presetId, input)` 保持两参数调用。Dream 的 `findConsolidatedNeighbors` 不传会话条件。两者都保留预设范围，不受隔离开关影响。

## 3. 来源字段如何进入并维护索引

数据链路：

```text
主库 living_memory_entry.sourceConversationId
  ├─ 仓库分页投影 → 重建 / 启动对账
  └─ 记忆写入返回值 → MemoryMutationService.document
       ↓
MemoryIndexSourceRecord / MemoryIndexDocument
       ↓ createVectorIndexDocument
VectorIndexDocument / VectorIndexInventoryItem
       ↓ Worker mutation
PGlite lm_index_memory.source_conversation_id
```

具体修改：

1. `src/contracts/vector_index.ts` 的两个索引记录类型增加来源字段。
2. `src/service/persistence/entries.ts` 的 `indexSourceFields` 增加该列；`selectEntryIndexSourcePage` 对投影结果的来源字段做规范化。复用 `normalizers.ts` 中现有 `normalizeSourceConversationId`，将其导出，不复制规则。
3. `src/service/app/memory_mutation_service.ts` 的 `document` 和 `src/service/vector_index/documents.ts` 的转换函数透传该字段。
4. `worker_protocol.ts` 的文档与清单增加字段；`worker/queries.ts` 的 `readVectorIndexInventoryPage` 查询并返回它。
5. `worker/mutations.ts` 的 replace 和 preserve 两条 SQL 都写入该列。preserve 继续只更新元数据，完全不赋值 embedding 列。
6. `reconcile.ts` 的 `requiresMetadataUpdate` 比较来源字段，保证仅来源变化也能触发 preserve 更新。

新增、导入、编辑、归档 / 激活、Dream 合并都复用现有变更和对账通道。Dream 的合并策略不改，但合并后产生的新来源字段必须同步到索引。

历史空串和 `webui:` 伪会话键按现行口径进入索引为 null。本轮不额外写回主库历史行，更新历史清理备忘说明这一状态。

## 4. SQL 过滤的具体位置

`worker/queries.ts` 的 `appendFilters` 是语义和关键词查询共用的过滤入口。收到 conversationId 时追加参数化条件：

```sql
WHERE preset_id = $1
  AND status = 'active'
  AND (source_conversation_id = $n OR source_conversation_id IS NULL)
```

保留原有 type 和 is_consolidated 条件。语义查询在此基础上计算相似度、排序并 LIMIT；关键词查询在 JOIN / GROUP BY 之前应用同样的条件，随后按已有混合评分逻辑合并、排序并截断。

现有关键词 SQL 用字符串 `m.` 拼接每个完整条件，加入括号 OR 条件后会产生错误 SQL。改为让 `appendFilters` 接收可选表别名：语义查询不传，关键词查询传 `m`；构造条件时限定各列名，移除对完整条件加前缀的做法。

在新建和升级索引时增加部分索引：

```sql
CREATE INDEX lm_index_memory_conversation_filter
ON lm_index_memory (preset_id, source_conversation_id)
WHERE status = 'active';
```

索引内保留全部记忆。开关改变的只是查询条件，切换开关无需重建索引或改写记忆来源。

## 5. v3 → v4 原地升级的执行顺序

### 5.1 版本与入口

将 `worker/schema.ts` 的 `VECTOR_INDEX_SCHEMA_VERSION` 从 3 升至 4，新建索引直接创建带来源字段的 v4 表。

在 Worker 协议、client、runtime 和 database 中增加一次明确的 `upgradeSchema` 命令；它只实现 v3 → v4，不建立迁移注册表或版本链框架。

### 5.2 启动编排

由 `maintenance.ts` 的 `initialize` 决定：

1. 保持现有 embedding 上下文创建和模型维度探测。
2. 判断是否是 v3 → v4，并检查现有存储引擎、pgvector 版本、embedding 模型和维度兼容性。
3. 只有结构版本这一项需要升级时，走“原地升级 + 对账”；其他不兼容原因继续走既有重建流程。
4. 原地升级放在启动 reconcile job 的独占操作区间内，先执行 Worker 升级命令，再执行 `reconcileAllPresets`。沿用现有任务记录与 building / dirty / ready 状态，不增加另一套任务系统。
5. 全部对账完成后重新 inspect 并发布 ready 状态。

Worker 已持有目录所有权；升级在数据库 open 成功后独立执行，不放进 `openOwned` 的打开失败 / 隔离损坏目录恢复分支。

### 5.3 结构事务

在 PGlite Worker 的一个事务内执行：

```sql
ALTER TABLE lm_index_memory ADD COLUMN source_conversation_id text;
CREATE INDEX lm_index_memory_conversation_filter
ON lm_index_memory (preset_id, source_conversation_id)
WHERE status = 'active';
UPDATE lm_index_manifest SET schema_version = 4 WHERE singleton = 1;
UPDATE lm_index_preset_state SET state = 'building';
```

表结构与版本号一起提交；旧 embedding、关键词关系、记忆 ID 和索引 generation 保留。新列初值为 null，仅代表“尚待对账”，初始化未完成前不能参与检索。

### 5.4 来源补齐与失败恢复

现有 reconcile 按预设和分页读取主库来源，与索引 inventory 比较。来源不同而正文未变时发 preserve mutation；真正缺失或正文变化的条目才进入既有 embedding 计算分支。

| 中断位置 | 下次启动的行为 |
| --- | --- |
| 加列事务未提交 | 仍为 v3，重新执行结构事务 |
| 结构事务完成，来源尚未补齐 | 已为 v4，直接重跑启动对账；根据实际来源差异补齐 |
| 部分预设已补齐 | 启动对账逐预设检查，已一致的记录无需重复更新 |
| 对账发生错误 | 沿用任务失败和索引不可用状态；错误不触发丢弃目录或全量重算的兜底 |

本方案不承诺完全零 embedding 请求：现有启动维度探测继续运行，真正缺失或变化的条目按既有规则处理；字段升级本身不重算已有正文向量。

## 6. 修改清单与实施依赖

| 顺序 | 文件 / 模块 | 具体交付 |
| --- | --- | --- |
| 1 | `src/index.ts`、`src/contracts/workflows.ts` | 配置默认值、搜索 provider 的内部会话参数 |
| 2 | `src/contracts/vector_index.ts`、`persistence/entries.ts`、`persistence/normalizers.ts` | 索引记录字段、分页投影与来源规范化 |
| 3 | `app/memory_mutation_service.ts`、`vector_index/documents.ts`、`worker_protocol.ts`、`worker/mutations.ts`、`reconcile.ts` | 日常写入和对账能够保存、比较来源元数据 |
| 4 | `worker/schema.ts`、`worker/database.ts`、`worker/runtime.ts`、`worker_client.ts`、`maintenance.ts` | 新建 v4 索引、定向升级命令、启动升级和对账 |
| 5 | `worker/queries.ts`、`vector_index/service.ts` | 参数透传、清单读取、两种 SQL 查询在候选截断前过滤 |
| 6 | `plugins/living_memory_tools.ts`、搜索工具、应用门面、Recall coordinator / retriever / engine / agentic | 三条入口按配置传递真实会话；管理与 Dream 调用不传条件 |
| 7 | README、历史会话键备忘、CHANGELOG、本方案 | 用户可见行为、兼容边界、完成状态与验证证据 |

以上实现尽量在既有函数中增加字段和参数。无需新增策略对象、访问控制服务、通用迁移框架或目录层级。

## 验收条件

- 关闭开关时，同预设跨会话搜索保持原样。
- 开启时，当前会话和全局记忆可见；其他会话、其他预设和归档记忆不进入检索结果。
- 语义与关键词两条路径均先过滤，其他会话记忆不会占用候选名额。
- 正常 ChatLuna、Character 和自动 Agentic Recall 使用各自正确的会话键。
- 旧索引升级保留向量，补齐期间不可检索，重启可恢复，日常来源变更可同步。
- 管理操作、画像和 Dream 范围保持既定语义。

## 已接受边界

Dream 跨来源合并仍可产生全局记忆；用户画像继续共享。旧快照不迁移或清理，后续召回成功产生结果时整体替换，无结果或失败时保留旧快照。`living_memory_get_messages` 保持预设归属校验。本功能控制召回和搜索范围，不构成所有读取入口的权限隔离。

## 验证记录

### 验证方式

执行 `yarn lint`、`yarn atsc -p tsconfig.json --noEmit`、`yarn build:server`、`git diff --check`，以及既有召回、工具、索引查询、Worker、服务、重建和持久化投影相关测试。已有 fixture 根据新增必填来源字段同步，不为本轮额外建立长期测试框架。

另用临时 PGlite 索引和固定向量做行为验收，不调用真实模型服务、不接触运行中数据库：

| 场景 | 数据与判定 |
| --- | --- |
| 关闭隔离 | 同预设 A / B 会话和 null 来源均可命中 |
| 开启隔离 | 查询 A 只命中 A 和 null；加入其他预设及归档记录，确认均排除 |
| 截断顺序 | 构造 B 的相似度高于 A，limit=1，查询 A 仍能取得 A 的候选 |
| 关键词分支 | 只有 B 命中关键词时不得返回 B；A / null 的关键词命中按原规则评分 |
| 元数据变更 | 将记忆来源 A 更新为 B，preserve 后向量数值不变，A 查询不再命中 |
| 旧索引升级 | 构造 v3 表和固定向量，执行升级与对账，检查列、版本和来源正确且向量完全相同 |
| 中断后恢复 | 加列完成后重新打开索引再对账，确认不重复加列且能补齐来源 |
| 会话接线 | 验证普通 ChatLuna / Character 工具与内部 Agentic Recall 传入预期会话条件，关闭开关时不传 |

### 实际结果

2026-09-17 完成：

- `yarn lint`：通过，包括已有测试夹具的类型检查。
- `yarn atsc -p tsconfig.json --noEmit`：通过。
- `yarn build:server`：通过，服务端与两个 Worker 均生成。构建报告 `worker_artifacts.ts` 中既有的 CJS `import.meta` 警告，该文件本轮未修改。
- `git diff --check`：通过。
- 既有相关测试：13 个文件、97 项通过，覆盖工具、两种召回、混合查询、Worker、索引服务、重建、目录切换、投影、索引变更、配置和 Character 中间件。
- 临时验收：2 个文件、16 项通过。使用真实临时 PGlite 与 SQLite、固定向量和假模型验证，不接触运行中数据。临时脚本保存在 Git 忽略的 `tmp/conversation-isolation-*.spec.ts`，运行入口为 `yarn test --config tmp/conversation-isolation-vitest.config.ts`，不纳入提交。

临时验收的具体证据：

1. 构造真实 v3 表结构，首次启动在结构升级后人为中断来源补齐；期间检索失败，重启后索引达到 ready、版本为 4、generation 保持不变，未产生损坏隔离目录。
2. 升级前后的所有已有向量逐元素完全一致；两次启动只发生两次维度探测，没有记忆正文的 embedding 请求。
3. 同预设 A、B、全局、历史 WebUI 来源，以及归档与其他预设记录混合存放；关闭隔离返回同预设活跃记录，开启后只返回 A 与全局来源。B 相似度最高而 limit=1 时仍正确返回 A。
4. 关键词独立命中路径遵守相同来源条件；来源 A 改为 B 后通过 preserve 更新，向量不变且 A 不再检索到该记录。
5. 人为制造迁移事务中的索引名称冲突，确认加列和版本更新一起回滚，仍保留 v3 结构。
6. 验证普通 ChatLuna、Character 群聊 / 私聊工具、embedding-rerank 协调器和搜索引擎的参数传递；复用 13 项 Agentic Recall 场景开启隔离并断言内部搜索收到正确会话。

真实模型、线上聊天及用户已有索引的现场升级尚未执行；上述结果是静态检查和隔离环境验证。
