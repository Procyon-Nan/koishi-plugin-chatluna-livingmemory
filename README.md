# koishi-plugin-chatluna-livingmemory

> 适用于 ChatLuna 的长期记忆插件。

让 Bot 以第一人称的叙事记忆，记录下与你共度的时光。

## 功能

- 以预设（preset）为单位，自动、异步地提取和召回长期记忆
- ChatLuna 主插件会话在系统提示词后注入用户画像，在当前用户输入前注入记忆快照；Character（伪装）插件通过预设中的 `{living_memory}` 变量注入记忆快照和用户画像
- 由子模型结合近期对话检索记忆，整理成记忆快照
- 为对话模型提供记忆检索、来源消息查看和主动创建记忆的工具
- 通过手动全量 Dream 与自动增量 Dream 合并、更新和归档记忆
- 根据记忆生成用户画像，并在对话中注入
- 提供 Koishi Console WebUI，用于查看和管理记忆、快照、用户画像等数据

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
yarn workspace koishi-plugin-chatluna-livingmemory build
```

## 使用

1. 在 Koishi 中启用 `koishi-plugin-chatluna-livingmemory`。

2. 配置模型：

| 配置项           | 用途                                        | 是否必需 |
| ---------------- | ------------------------------------------- | -------- |
| `mainModel`      | 提取记忆，在 Dream 中整理记忆并生成用户画像 | 必需     |
| `subModel`       | 召回记忆                                    | 必需     |
| `embeddingModel` | 生成记忆向量，用于记忆检索与 Dream          | 必需     |
| `rerankModel`    | 对记忆检索结果重排序                        | 可选     |

如果你不知道应该如何配置 Embedding 嵌入模型和 Reranker 重排序模型，请参考[此文档](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/main/docs/embedding-reranker-guide.md)进行配置。

参考测试组合：

- LLM 模型：`gemma4:31b`
- Embedding 模型：`bce-embedding-base_v1`
- Reranker 模型：`bce-reranker-base_v1`

3. 记忆召回：

    `subModel` 结合近期对话与当前消息，通过 `living_memory_search` 检索活跃记忆，把整理后的记忆文本写入当前会话的快照，供后续对话注入。没有找到相关记忆时保留原有快照。

    `enableConversationIsolation` 默认关闭，同一预设内的会话共享记忆。开启后，自动召回和 `living_memory_search` 只检索当前会话产生的记忆与全局记忆（WebUI 创建的记忆、Dream 合并自不同会话的记忆）；用户画像、Dream 和管理操作仍在整个预设内进行。

4. 对于 ChatLuna 主插件，在插件配置中开启 `enableSnapshotInjection`。开启后，每次请求都会在当前用户输入之前注入最近一次召回的记忆快照，请求内的工具调用轮次沿用同一份快照。开启 `enableUserProfileInjection` 后，相关用户画像会插入在系统提示词之后。

5. 对于 Character（伪装）插件，需要在 Character 的预设文件 input 中写入变量以注入记忆快照和用户画像，例如：

```text
input: |
    # 你的记忆
    {living_memory}
```

6. 在 Koishi Console 侧边栏进入 Living Memory 页面，查看和管理记忆。

## Dream 整理流程

- 预设的活跃记忆少于 30 条时不执行 Dream。
- 在 WebUI 中手动执行 Dream 会对预设的全部活跃记忆聚类整理；开启 `enableUserProfileInjection` 时，完成后更新用户画像。
- 开启 `enableAutoDream` 后，未整理的记忆达到 `autoDreamMemoryGrowthThreshold` 条时自动执行增量 Dream。每次只整理最早的一批（条数同该阈值），并与相关的已整理记忆一同比对，不生成用户画像。
- Dream 失败时，未整理的记忆保留到下一次 Dream 继续处理。
- 导入预设不会触发自动 Dream。跨预设导入的记忆以未整理状态写入，导入完成后 WebUI 会提示手动执行一次 Dream。

## 记忆隔离机制

长期记忆按预设隔离，群聊和私聊共享同一预设的记忆。

记忆快照按会话隔离：

| 接入方式          | 长期记忆分区          | 快照隔离方式                                                |
| ----------------- | --------------------- | ----------------------------------------------------------- |
| ChatLuna 主插件   | 原始 preset 名        | `conversationId`                                            |
| Character（伪装） | `预设名（Character）` | `private:{userId}` 或 `group:{guildId}` 形式的 `sessionKey` |

同一预设的不同会话共享长期记忆，但各自使用独立的记忆快照，召回结果不会串到其他会话。

## 自动提取白名单

开启 `enableExtractionWhitelist` 后，只有 `extractionWhitelist` 中的会话会自动提取记忆。

白名单填写平台原始 id：群聊填群号，私聊填对方的 QQ 号。ChatLuna 主插件与 Character 共用同一份列表。列表为空时不会自动提取任何记忆。

白名单只限制自动提取。白名单外的会话照常召回记忆、注入快照和用户画像，也可以使用 `living_memory_create_memory` 创建记忆。

## 记忆工具

### `living_memory_search`

在当前预设中检索记忆，结果按相关度排序。

| 参数             | 说明                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `searchTexts`    | 必填，1 到 3 条第一人称的完整句子，每条 2 到 100 个字符，用于语义检索 |
| `searchKeywords` | 选填，最多 3 个实体名称，每个 2 到 10 个字符，用于关键词匹配          |
| `memoryStatus`   | 必填，`active`（活跃记忆）、`archived`（已归档记忆）或 `all`          |

返回每条记忆的 `id`、类别、更新时间、情绪色彩、来源会话和正文。返回条数上限由 `memorySearchToolMaxResults` 设置，语义相似度门槛由 `memorySearchMinSimilarity` 设置。

### `living_memory_get_messages`

按 `living_memory_search` 返回的记忆 `id` 查看单条记忆的全部来源消息。

### `living_memory_create_memory`

开启 `enableMemoryCreationTool` 后注册，允许模型在对话中主动创建记忆，用于响应用户“记住这个”之类的请求，或记录模型认为重要的信息。

参数 `memories` 是记忆数组，单次条数上限由 `memoryCreateToolMaxMemories` 设置。每条记忆的字段与自动提取一致：`type`、`content`、`summary`、`keywords`、`speakerLabels`、`sentiment`、`importance`。

返回已创建记忆的 `id` 与类别。此工具创建的记忆没有来源消息。与自动提取同时开启时，同一件事可能被记录两次，由 Dream 合并。

## 日志

默认日志记录召回快照的更新内容、Dream 的启动、完成与失败，以及索引维护等运维事件。

开启 `debug` 后，额外记录 Recall、Extraction、Dream（含用户画像）每一次模型调用的完整 Prompt、原始响应与诊断事件。
