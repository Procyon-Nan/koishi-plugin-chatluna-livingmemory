# 向量索引

## 数据与同步

- Koishi 主数据库保存记忆事实，PGlite/pgvector 保存派生索引，通过 reconcile 或 rebuild 恢复一致性。
- embedding 由记忆正文生成。正文变化时重新生成向量，其余字段变化保留向量；字段变更同步索引文档与关键词索引。
- 模型检索固定查询活跃记忆。底层索引支持按 `memoryStatus` 查询，归档向量继续维护，重新激活时复用。
- Dream 通过 `readDreamVectors` 分页读取已有正文向量。同一 Worker 事务返回正文 hash、状态和模型、维数、generation；向量 buffer 转移给主线程。Dream 组批入口负责与本轮正文快照核对，读取过程调用 embedding 次数为 0。

## Worker 与目录所有权

入口：`src/service/vector_index/worker_client.ts`、`src/service/vector_index/worker/database.ts`。

- 同一 Worker 持有 PGlite 连接和目录所有权：取得所有权后打开数据库，关闭数据库后释放所有权；重建切换目录期间持续持有所有权。
- 同机互斥使用 Windows 命名管道或 Linux 抽象 Unix Socket，端点标识取规范化目录的稳定哈希。
- 一个运行中的索引目录由单个进程独占。
- 停止服务时停止接收操作，排空在途操作并等待 Worker 退出；关闭失败时终止 Worker。
- 新 HMR generation 等待旧 generation 的 Worker 结束后启动。

## 预设状态与读取门禁

入口：`src/service/vector_index/status_store.ts`、`src/service/vector_index/operation_gate.ts`。

- `lm_index_preset_state` 保存 `ready`、`dirty` 终态；`building`、`unavailable` 等瞬态保存在主进程内存。
- 状态账本对应数据库条目或索引文档中存在的预设，孤儿行通过全量对账清除。
- 读取就绪状态按预设判断。manifest 缺失、全局维护窗口或 Worker 故障时暂停全部读取；单个预设未就绪时只阻止该预设的读取。
