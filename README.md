# koishi-plugin-chatluna-livingmemory

> 适用于 ChatLuna 的长期记忆插件。

让 Bot 以第一人称的叙事记忆，记录下与你共度的时光。

## 功能

- 通过 `{living_memory}` 变量向 prompt 中注入记忆快照。
- 按预设（preset）分区保存记忆，支持同一预设跨会话共享长期记忆。
- 异步进行记忆检索与召回，并把召回结果写入记忆快照，供下一轮对话使用。
- 异步进行记忆总结与存储，将对话转化为符合预设角色风格的第一人称叙事记忆。
- 提供独立的记忆整理流程，用于合并相似记忆、归档过时记忆和减少重复项。
- 提供 Koishi Console WebUI，方便手动查看、创建、编辑、删除记忆和快照。
- 支持标准 ChatLuna 主插件会话，也支持已适配生命周期事件的 Character（伪装）会话。
- ~~在 WebUI 中提供 ChatLuna 主插件的会话管理。~~

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

| 模型类型 | 用途 | 是否必需 |
| --- | --- | --- |
| LLM 模型 | 从对话中提取记忆 | 必需 |
| Dream LLM 模型 | 进行 Dream 记忆整理与合并决策 | 必需 |
| 召回查询改写 LLM 模型 | 在召回前改写检索查询 | 可选 |
| 嵌入模型 | 进行记忆向量化检索 | 可选 |
| Reranker 模型 | 对召回结果重排序 | 可选 |

参考测试组合：

- LLM 模型：`gemma4:31b`
- Embedding 模型：`bce-embedding-base_v1`
- Reranker 模型：`bce-reranker-base_v1`

3. 在需要记忆注入的 ChatLuna 主插件或 Character（伪装）预设中写入记忆变量：

```text
{living_memory}
```

4. 与 Bot 开始对话。

5. 在 Koishi Console 侧边栏进入 livingmemory WebUI，进行记忆的查看和管理。

## 记忆隔离机制

记忆条目仅依照预设隔离，群聊和私聊之间不进行长期记忆隔离。

预设召回使用的记忆快照依照会话隔离：

| 接入方式 | 长期记忆分区 | 快照隔离方式 |
| --- | --- | --- |
| ChatLuna 主插件 | 原始 preset 名 | `conversationId` |
| Character（伪装） | `预设名（Character）` | `private:{userId}` 或 `group:{guildId}` 形式的 `sessionKey` |

这意味着：同一预设在不同会话中会共享长期记忆，但每个会话会使用各自的记忆快照，避免召回结果直接串到其他会话。
