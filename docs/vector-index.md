# 向量索引

## 数据与同步

- Koishi 主数据库保存记忆事实，PGlite/pgvector 保存派生索引，通过 reconcile 或 rebuild 恢复一致性。
- embedding 由记忆正文生成。正文变化时重新生成向量，其余字段变化保留向量；字段变更同步索引文档与关键词索引。
- Worker 通过 SQL 的 `embedding::text` 读取向量，按 pgvector 数值数组文本解码为 `Float32Array`。
- 模型检索固定查询活跃记忆。底层索引支持按 `memoryStatus` 查询，归档向量继续维护，重新激活时复用。
- Dream 通过 `readVectorSnapshot` 分页读取已有正文向量。同一 Worker 事务返回正文 hash、状态和模型、维数、generation；向量 buffer 转移给主线程。Dream 组批入口负责与本轮正文快照核对，读取过程调用 embedding 次数为 0。
- Worker 向量读取统一使用 `readVectorSnapshot`，索引重建、对账与事务回滚测试复用该接口。

## Dream HNSW 维护与查询

入口：`src/service/vector_index/maintenance.ts`、`src/service/vector_index/worker/dream_ann.ts`。

- 运行时使用 PGlite 0.5.11、pglite-pgvector 0.0.12，内嵌 vector 扩展 0.8.7。核心 schema 版本保持 4。
- 启动打开已有 0.8.1 扩展库后，关闭连接并生成同级 `vector-index.pglite.vector-0.8.1-backup-<uuid>` 冷备份；重新打开后通过事务升级扩展、同步已知旧版本的 manifest 扩展版本，保留模型、维数、generation 和正文向量。备份保留供发布验收和回退使用，清理由管理员处理。
- 升级错误通过 `extension-migration-failed` 上报，保留原目录和冷备份。升级成功后进入原有启动对账；原有维数探针照常执行一次 embedding。
- 启动对账或全量重建完成后，自动运行独立 `dream-ann` 索引维护任务。新库在批量写入与切换完成后建立索引；后续启动复用满足定义且 valid/ready 的索引。维护复用现有任务队列、操作门禁和 Worker，采用单线程、64 MB maintenance_work_mem。
- `lm_index_memory_dream_hnsw_v1` 覆盖主表所有 active 记忆，使用 cosine、m=16、ef_construction=64；后续写入由 PostgreSQL 同步维护。
- ANN 可用性由实际索引定义和 valid/ready 判断，独立于主体索引状态。构建 SQL 失败记录维护任务失败，主体 ready 时精确查询继续可用；Worker 故障沿用全局不可用处理。
- 普通向量与混合召回通过 MATERIALIZED CTE 计算完整过滤集合的距离，再排序和截断，保持精确检索语义。
- `queryDreamNeighbors` 每页接受 1–4 条直向量查询，核验 generation 和 HNSW 索引就绪状态后逐条执行短事务。每条使用局部 HNSW 搜索参数，由 PostgreSQL 优化器选择 HNSW 或精确扫描，返回 memoryId、contentHash。查询向量 buffer 转移至 Worker，由调用者提供可转移的查询副本。
- 返回的 `available` 表示候选查询可用。每条查询完成后检查 25 ms 软时间片，返回已完成前缀；`budget` 表示剩余行待后续页继续处理。`index-absent` 表示 HNSW 索引尚未就绪，由 Dream 保留容量二分初解。页内取消通过共享标记在查询之间生效，在途 SQL 排空后结束请求。
- Dream 多批次分组调用候选接口，在主线程完成快照筛选与覆盖判断，再由 Dream Worker 重评分和跨组修复，见 [Dream 流程](dream.md)。

## Worker 与目录所有权

入口：`src/service/vector_index/worker_client.ts`、`src/service/vector_index/worker/database.ts`。

- 同一 Worker 持有 PGlite 连接和目录所有权：取得所有权后打开数据库，关闭数据库后释放所有权；重建切换目录期间持续持有所有权。
- 同机互斥使用 Windows 命名管道或 Linux 抽象 Unix Socket，端点标识取规范化目录的稳定哈希。
- 一个运行中的索引目录由单个进程独占。
- 停止服务时停止接收操作，排空在途操作并等待 Worker 退出；关闭失败时终止 Worker。
- 新 HMR generation 等待旧 generation 的 Worker 结束后启动。
- 索引打开或检查失败时，停止启动并上报错误，保留索引内容。启动恢复依据明确的目录切换状态：正式目录缺失时恢复 previous 目录；正式目录可读且缺少 manifest、previous 目录存在时恢复 previous 目录。
- Worker 的目录清理警告通过消息协议传给主线程，由 `LivingMemoryLogger` 以 “索引工作线程警告” 输出。

## 维护日志

- 索引任务入口以中文 INFO 摘要记录开始与完成，展示预设和处理结果；任务失败采用 ERROR，携带预设、任务 ID 和完整错误。
- 对账分页进度仅更新任务记录，控制台按任务展示开始与最终结果。
- 服务层记录维护失败后的索引状态及原因；ANN 维护失败时记录 “Dream 近邻索引维护失败”，精确检索继续沿用主体索引状态。

## 预设状态与读取门禁

入口：`src/service/vector_index/status_store.ts`、`src/service/vector_index/operation_gate.ts`。

- `lm_index_preset_state` 保存 `ready`、`dirty` 终态；`building`、`unavailable` 等瞬态保存在主进程内存。
- 状态账本对应数据库条目或索引文档中存在的预设，孤儿行通过全量对账清除。
- 读取就绪状态按预设判断。manifest 缺失、全局维护窗口或 Worker 故障时暂停全部读取；单个预设未就绪时只阻止该预设的读取。
