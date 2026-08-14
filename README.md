# koishi-plugin-chatluna-livingmemory

> 适用于 ChatLuna 的长期记忆插件。

让 Bot 以第一人称的叙事记忆，记录下与你共度的时光。

## 功能

- 以预设（preset）为核心，全自动、异步地进行长期记忆的生成与召回
- 标准 ChatLuna 会话会在系统提示词后注入用户画像，并在历史上下文之后、当前用户输入之前注入记忆快照；Character（伪装）插件通过预设中的 `{living_memory}` 变量注入记忆快照和相关用户画像
- 提供 `embedding-rerank` 与 `agentic-recall（实验性）` 两种记忆召回策略
- 提供 `living_memory_search` 与 `living_memory_get_messages` 记忆工具，供模型查询记忆并按记忆 id 查看来源消息
- 通过手动全量 Dream 与自动增量 Dream 执行记忆库的合并、更新与归档
- 根据记忆内容形成用户画像，并在对话中实时注入
- 提供 Koishi Console WebUI，方便手动查看、创建、编辑、删除记忆和快照等数据

## 安装方式

### 在线安装

在 Koishi 的插件市场中搜索 `chatluna-livingmemory`，并选择添加。

### 本地开发

1. 在本地 Koishi 项目的根目录中克隆仓库：

```bash
yarn clone https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory.git
```

2. 在本地 Koishi 项目的根目录中构建：

```bash
yarn build chatluna-livingmemory
```

## 使用

1. 在 Koishi 中启用 `koishi-plugin-chatluna-livingmemory`。

2. 配置模型：

| 配置项           | 模型用途                                                           | 是否必需                                    |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `mainModel`      | 提取长期记忆，并在 Dream 中整理记忆和生成用户画像                  | 启用自动提取或 Dream 时必需                 |
| `subModel`       | 改写 `embedding-rerank` 查询，或执行 `agentic-recall`              | 查询改写或 `agentic-recall` 启用时必需      |
| `embeddingModel` | 为记忆检索、模型工具、手动 Dream 聚类和自动增量 Dream 检索生成向量 | 两种召回策略和 Dream 均必需                 |
| `rerankModel`    | 对 `embedding-rerank` 的候选记忆重排序                             | 可选；未配置或调用失败时使用 embedding 排序 |

如果你不知道应该如何配置 Embedding 嵌入模型和 Reranker 重排序模型，请参考[此文档](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/main/docs/embedding-reranker-guide.md)进行配置。

参考测试组合：

- LLM 模型：`gemma4:31b`
- Embedding 模型：`bce-embedding-base_v1`
- Reranker 模型：`bce-reranker-base_v1`

3. 在插件配置中选择记忆召回策略：

    - `embedding-rerank`：可选使用 `subModel` 改写查询，使用 embedding 检索候选记忆，并在 reranker 可用时重排序，最后将 top-K 记忆引用写入快照。

    - `agentic-recall（实验性）`：由 `subModel` 结合近期对话和当前消息，调用 `living_memory_search` 查询记忆，再将最终记忆文本和搜索轨迹写入快照。

4. 对于 ChatLuna 主插件，在插件配置中开启 `开启记忆快照注入`。开启后，会在历史上下文之后、当前用户输入之前自动注入最近一次成功召回的记忆快照；同一次主插件请求内如果发生工具调用，后续模型调用会继续使用同一份记忆快照注入。开启用户画像注入后，相关用户画像会以 system 语义插入在系统提示词之后，并同样在同一次主插件请求内保持可用。

5. 对于 Character（伪装）插件，需要在 Character 的预设文件 input 中写入变量以注入记忆快照和已启用的用户画像，例如：

```text
input: |
    # 你的记忆
    {living_memory}
```

6. 在 Koishi Console 侧边栏进入 livingmemory WebUI，进行记忆的查看和管理。

## Dream 整理流程

- WebUI 中的手动 Dream 会对当前预设的 active 与 archived 记忆分别执行分区聚类和整理，完成后按配置更新用户画像。
- 自动 Dream 以尚未完成 consolidation 的记忆数量作为触发依据。阈值同时是单次任务的批次大小；每次只处理最早的一批，不会连续清空全部积压。
- 自动 Dream 先整理本批新增记忆，再将仍需处理的记忆逐条与同状态的旧记忆进行 content 向量检索，每条最多读取 30 条候选。该流程不执行 HDBSCAN，也不生成用户画像。
- 自动 Dream 同时依赖 `mainModel` 和 `embeddingModel`。模型调用、Embedding 或持久化失败会保留未完成记忆，供后续任务继续处理。
- 预设导入不会触发自动 Dream。跨预设导入的记忆会作为未整理数据写入，WebUI 会在导入完成后提示手动执行一次全量 Dream。

## 记忆隔离机制

记忆条目仅依照预设隔离，群聊和私聊之间不进行长期记忆隔离。

预设召回使用的记忆快照依照会话隔离：

| 接入方式          | 长期记忆分区          | 快照隔离方式                                                |
| ----------------- | --------------------- | ----------------------------------------------------------- |
| ChatLuna 主插件   | 原始 preset 名        | `conversationId`                                            |
| Character（伪装） | `预设名（Character）` | `private:{userId}` 或 `group:{guildId}` 形式的 `sessionKey` |

这意味着同一预设在不同会话中会共享长期记忆，但每个会话会使用各自的记忆快照，避免召回结果直接串到其他会话。

## 记忆查询工具

`living_memory_search` 是提供给模型调用的记忆查询工具。它会在当前预设的 active 记忆中进行检索，并按匹配相关度排序返回结果。

模型可填写的工具参数包括：

| 字段             | 说明                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `searchTexts`    | 必填，1 到 3 个语义查询短语，每个 2 到 100 个字符，须为第一人称的完整句子描述                       |
| `searchKeywords` | 选填，最多 3 个精确关键词，每个 2 到 10 个字符，用于关键词匹配                                      |
| `memoryTypes`    | 必填，记忆类别，可选 `identity`、`preference`、`fact`、`plan`、`context`、`other`，或单独使用 `all` |

工具返回结果包含记忆 `id`、记忆类别、记忆内容、摘要、关键词、重要度、创建时间、更新时间。返回结果不会包含 `status` 或来源消息。

`living_memory_get_messages` 用于在当前预设内按记忆 `id` 批量查看来源消息。它只接受 `living_memory_search` 返回的记忆 `id`，每次最多查询 10 条记忆。返回结果包含目标记忆的基本信息、按 `originIndex` 编号的 `sourceOrigins`，以及未找到或不属于当前预设的 `notFoundMemoryIds`。

默认日志会记录 Recall 快照更新后的完整最终注入文本、Recall 无结果时的快照保留事件、Dream 的启动/完成/失败，以及低频运维和索引事件。

启用 `debug` 后，还会记录 Recall、Extraction、Dream（含用户画像）的每一次真实模型调用，包括完整 Prompt、完整原始响应、解析状态和关联标识。此类日志包含对话、预设提示词和记忆正文，仅应在访问受控的环境启用。API Key、Authorization、访问令牌、密码等基础设施凭证字段会统一掩码。
