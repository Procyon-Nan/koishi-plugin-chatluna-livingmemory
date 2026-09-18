# 旧版 WebUI 伪会话键的迁移清理备忘

## 背景

`living_memory_entry.sourceConversationId` 记录记忆的来源会话键
（ChatLuna 为 conversation UUID，Character 为 `group:{guildId}` /
`private:{userId}` sessionKey）。历史版本的 WebUI 手工创建记忆没有真实
会话上下文，客户端以 `webui:{presetId}` 占位符作为键写入。该命名空间
只由 WebUI 创建路径产生，真实会话键（UUID、`group:`/`private:` 前缀）
不可能以 `webui:` 开头。

## 现行口径

- 表列改为可空，`sourceConversationId == null` 是「无会话归属、全局
  可见」的单一判定；开启会话隔离时，全局记忆和当前会话记忆共同参与检索。
- WebUI 手工创建不再发送 conversationId，落库为 null。
- `normalizeEntryRecord` 在读取边界把空串与 `webui:` 前缀折叠为 null，
  因此导出、列表与后续隔离谓词看到的旧值已经是 null。
- 向量索引的源记录分页投影复用同一规范化函数；v4 索引的来源列通过启动
  对账补齐，历史伪会话键在索引中保存为 null。日常索引写入同步规范化后的
  来源字段，语义与关键词检索在取候选前应用来源条件。

## 待办：写回迁移

读时折叠不改动数据库行，`webui:` 旧值会一直留在库里。任何绕过
normalizer 的原始查询都会看到幽灵键，且数据口径长期依赖代码补偿。

- 时机：留待主库历史数据清理时实施。本次会话隔离复用读取规范化，
  仅升级 PGlite 索引结构，不额外迁移主库历史行。
- 形态：服务启动时的一次性迁移，等价于
  `UPDATE living_memory_entry SET sourceConversationId = NULL WHERE sourceConversationId LIKE 'webui:%'`，
  覆盖活跃与归档行；MySQL / PostgreSQL / SQLite 语法一致。
- 完成条件：迁移落地后删除 `normalizers.ts` 中针对 `webui:` 前缀的
  折叠分支（空串折叠保留），并更新或删除本文档。
