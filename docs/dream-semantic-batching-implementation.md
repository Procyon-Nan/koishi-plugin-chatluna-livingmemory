# Dream 大规模记忆语义分组实施方案

日期：2026-10-22  
适用项目：Procyon-Nan/koishi-plugin-chatluna-livingmemory  
源码基线：0.28.0，commit 734123e9e123abd6d51f425735fabe436fb3a918  
建议落库位置：docs/dream-semantic-batching-implementation.md

## 本地执行进度

2026-10-25：第一批代码接入容量二分、Dream 向量快照读取、Worker 数组转移与取消、准备阶段串行队列，并前移模型容量检查。当前执行 initial，refinement 配置随第三批实际修复功能接入。第一批相关测试已同步；自动化检查、规模资源测量及业务质量验收在版本更新前集中执行。后续依照第 14 节推进依赖升级、HNSW 和跨组修复。

2026-10-25：第二批代码接入 PGlite 0.5.11 / pglite-pgvector 0.0.12、普通召回精确 CTE、0.8.1→0.8.7 冷备份与升级事务、主表 active HNSW 以及 Dream ANN 小页接口。按用户决策，启动对账与全量重建完成后自动运行独立 HNSW 维护任务，后续复用已有索引。每页最多 4 条，逐条验证 EXPLAIN、检查 25 ms 软时间片与共享取消标记。测试覆盖已补充，暂缓执行；迁移事务测试使用模拟旧版本元数据，真实旧二进制库副本兼容性与第 14 节性能验收仍待版本更新前执行。当前 Dream 组批继续使用 initial，候选收集与跨组修复属于第三批。

## 1. 实施结论

将 Dream 的分组实现替换为：

**容量约束的递归球面二分 → 原有 PGlite 中的 HNSW 全局近邻候选 → 有预算的跨组移动和交换 → 完整覆盖与容量验证 → 原有 Dream 工具会话。**

首版针对约 10,000 条记忆、768 / 1024 维正文向量、2 核 / 2–4 GB 环境设计。使用已经存储的正文 embedding。每条原始记忆在分组计划中出现一次，每组 1–30 条；初始组数 K = ceil(N / 30)，10,000 条得到 334 组。组内条数可以不同。算法输出继续适配现有 DreamCluster[]，保留既有模型工具、事实写入、覆盖统计和画像链路。

工程上选择一条主路线：**主向量表增加 active 部分 HNSW 索引，普通召回明确使用精确查询，Dream 通过单独的直向量接口获取候选。** 先实现容量二分，再接入索引和局部修复。两棵随机树、独立向量数据库、第二份 Dream 向量表、全局最优传输和全局匈牙利匹配留在研究对照中。

这是可以逐步交付的启发式实现。容量、覆盖和停止条件可以严格验证；最终整理质量需要真实记忆集验证。候选近邻召回、同批关系覆盖和 LLM 整理结果分别验收。

## 2. 与当前实现的对应关系

以下现状以固定源码基线为准，参见文末 S1–S6。

| 当前职责 | 现有位置 | 本次处理 |
| --- | --- | --- |
| 关键词分区约 300 条、HDBSCAN、全局噪声重聚类、超大簇再切分 | src/service/workflows/dream/clustering.ts | 统一替换为新 planner |
| Dream 正文输入 | full.ts；persistence/entries.ts | 保留一份现有 DreamMemoryEntryRecord[]，按稳定 ID 排序 |
| 分组返回格式 | dream/types.ts 的 DreamCluster | 保留 id 与 entries；entries 引用原记录 |
| 向量读取 | contracts/vector_index.ts；vector_index/service.ts；worker/queries.ts | 新增 Dream 专用读取，返回向量及正文 hash、索引 manifest |
| 向量相似度查询 | vector_index/worker/queries.ts | 新增 Dream ANN 查询；普通 queryKnn 明确保持 exact |
| 计算 Worker | dream/worker/protocol.ts、client.ts、entry.ts | 新增 bisect / refine 命令、共享取消标记与进度 |
| 模型会话 | dream/session/runner.ts、history.ts、state.ts、tools.ts | 首版复用现有业务规则，增加 planner 结果与信号接线 |
| 事实写入 | app/memory_mutation_service.ts 与 persistence/repository.ts | 继续使用原写入口、事务及 factsCommitted 语义 |
| 任务启动与排空 | dream/coordinator.ts、job_runner.ts | 保留 preset 互斥，增加全局规划串行队列 |

当前 full.ts 一次读取全部 Dream 正文。现有 Dream 投影已经排除 embedding 和 sourceOrigins；首版仅在主线程持有这份正文，Worker 接收数值数组。按批最后读取正文会改变输入版本语义，适合另行设计。

当前 Dream 使用一个共享工具会话；每批最多 60 轮，连续 3 轮无有效操作会跳过剩余项，还可能调用历史摘要及画像模型。因此，**334 是分组数量，模型请求数量由实际工具会话决定。**

## 3. 首版边界与必须成立的约束

### 3.1 覆盖与容量

在规划开始时捕获当前 preset 的全部 active 记忆，包括已固化项；固定这一轮 targetMemoryIds。本轮工具 merge / split 返回的新 ID 按原规则加入 available；外部提取或 WebUI 在运行期间新增的记忆留给下一轮。原始覆盖目标保持固定。

规划输出需要通过独立检查：

1. 输入 ID 唯一，输出出现次数逐 ID 等于 1。
2. 输出记录数等于 N，输出中每个 ID 属于原始目标。
3. 每组条数在 1–30 内，初始与修复后的组数均为 K。
4. labels[i] 在 [0, K) 内，各组实际计数与 sizes 一致。
5. 所有进入余弦计算的向量维数一致、分量有限、范数为正。
6. 向量对应的 contentHash 与捕获的正文一致，model / dimension / generation 与运行 manifest 一致。

目标覆盖检查放在 planner 输出处，独立于 session 中的 Set 去重。这样可以直接发现规划重复或遗漏。

### 3.2 两种可用结果

结果阶段仅有：

- initial：容量二分已经完整结束，覆盖与容量检查通过。
- refined：从合法 initial 出发，在同一张冻结稀疏图上完成若干严格正收益操作。

候选预算到期、候选不足或 HNSW 尚未就绪时，可以使用 initial，并在任务诊断中标出原因。用户取消、正文与向量不一致、完整初解尚未完成、索引主体故障、Worker 故障或计划校验失败时，结束当前准备阶段，沿用任务失败或取消处理。

### 3.3 配置边界

首版新增一个用户配置：

~~~ts
dreamSemanticRefinement: boolean
~~~

false 使用容量二分；true 尝试 HNSW 候选和稀疏修复，满足初解退回条件时记录实际阶段。最终发布目标默认 true；开发与分阶段合入期间先以 false 验证初解。

其余参数先放在 Dream 附近的内部常量中。批大小 30、候选数、修复预算和 LLM 每批轮数分别命名，普通检索的 maxCandidates / minSimilarity 继续表达普通检索行为。

## 4. 一万条记忆的实际执行顺序

1. 任务通过现有 preset 锁进入规划队列。全局最多一个规划任务占用向量矩阵和算法 Worker。
2. 获得规划执行权后检查取消，读取并稳定排序正文，建立固定目标集合。
3. 创建模型并提前验证既有输入容量条件，捕获 embedding model、dimension 和 index generation。
4. 每次读取最多 256 条已存向量，同时取得 contentHash，填入一份连续 Float32Array。
5. 在 Dream Worker 中计算向量范数、按单位方向完成容量二分，产生 334 个合法组，并把原矩阵所有权交回主线程。
6. 主线程保留初解标签，逐小页从冻结矩阵复制查询向量，交给现有向量 Worker 查询 HNSW。
7. 按冻结目标和正文 hash 筛选候选，每点候选缓存宽度 M = 64；完成候选完整度验收。
8. 将矩阵、候选数组和一份初解标签副本转移给 Dream Worker，重算原维度余弦后保留每点 q = 10 个近邻，生成稀疏图，执行有预算的 move / swap。
9. 校验最终标签，映射为 DreamCluster[]，释放数值工作集，退出规划队列。
10. 解析人设与 speaker，创建既有工具，逐批进入同一 Dream 会话。
11. 会话沿用覆盖统计、工具事务、历史压缩、跳过与画像逻辑，记录实际模型请求数。

人设生成可能触发模型请求，放在规划队列之外。正文快照保留到该轮会话结束；向量矩阵和候选图在 LLM 阶段前解除引用。

全局规划串行化控制的是算法工作集。多个 preset 的 LLM 会话仍可能重叠，整机验收必须记录实际同时运行的 Dream 数量；首个 2 GB 验收场景限定一个 Dream 加正常业务负载。

## 5. 数据结构与接口

以下是接口规格，字段需要随项目现有错误类型、日志与协议风格落地。

### 5.1 固定输入与内部计划

~~~ts
interface DreamPlanManifest {
    plannerVersion: 1
    jobId: string
    presetId: string
    embeddingModelId: string
    dimension: number
    indexGeneration: string
    seed: number
    targetCount: number
}

interface DreamVectorMatrix {
    entryCount: number
    dimension: number
    // 行号对应排序后的 entries；一份连续的 Float32 数据。
    vectors: Float32Array<ArrayBuffer>
}

interface DreamPlanLabels {
    labels: Uint32Array<ArrayBuffer>
    sizes: Uint32Array<ArrayBuffer>
    clusterCount: number
}

interface DreamPlanningDiagnostics {
    stage: 'initial' | 'refined'
    initialMs: number
    candidateMs: number
    refineMs: number
    queriedRows: number
    fullCandidateRows: number
    directedCandidateCount: number
    graphEdgeCount: number
    acceptedMoves: number
    acceptedSwaps: number
    edgeVisits: number
    hintEdgeVisits: number
    graphComplete: boolean
    initialObjective?: number
    finalObjective?: number
    stopReason: string
}
~~~

正文 ID、hash 和行号对应关系留在主线程。算法 Worker 根据整数行号工作，最终使用 labels 映射回原正文对象。

候选采用固定行宽布局：

~~~ts
interface DreamCandidates {
    q: number
    width: number                    // 首版 M = 64
    counts: Uint8Array<ArrayBuffer>   // 长度 N
    neighbors: Uint32Array<ArrayBuffer> // 长度 N*M；只读每行 counts[i] 项
}

interface DreamSparseGraph {
    offsets: Uint32Array<ArrayBuffer> // N+1
    neighbors: Uint32Array<ArrayBuffer>
    weights: Float32Array<ArrayBuffer>
}
~~~

counts 的类型随候选缓存上限演进；当前 M = 64，q = min(10,N-1)。候选布局中的剩余槽位由 counts 界定，节点 0 是有效索引。N≤1 的算法边界直接在 initial 阶段返回。

### 5.2 Dream 专用向量服务

在 contracts/vector_index.ts 新增专用 provider，替换 Dream 对 ManualDreamVectorReader 的依赖；普通搜索接口保持原职责。

~~~ts
interface DreamVectorReadItem {
    memoryId: string
    contentHash: string
    status: 'active' | 'archived'
    vector: Float32Array<ArrayBuffer>
}

interface DreamVectorReadPage {
    embeddingModelId: string
    dimension: number
    generation: string
    items: DreamVectorReadItem[]
    missingMemoryIds: string[]
}

interface DreamNeighborQuery {
    sourceIndex: number
    presetId: string
    generation: string
    sourceMemoryId: string
    vector: Float32Array<ArrayBuffer>
    limit: number
    efSearch: number
}

interface DreamNeighborHit {
    memoryId: string
    contentHash: string
    cosineScore: number
}

interface DreamNeighborPageResult {
    generation: string
    completed: number
    backend: 'hnsw' | 'unavailable'
    rows: Array<{ sourceIndex: number; hits: DreamNeighborHit[] }>
    reason?: 'index-absent' | 'plan-exact' | 'budget'
}

interface DreamVectorProvider {
    readDreamVectors(
        presetId: string,
        memoryIds: string[],
        signal?: AbortSignal
    ): Promise<DreamVectorReadPage>

    queryDreamNeighbors(
        queries: DreamNeighborQuery[],
        signal?: AbortSignal
    ): Promise<DreamNeighborPageResult>
}
~~~

一次 queryDreamNeighbors 请求的 queries 上限为 4，同页使用相同 preset、generation 和查询参数档；后台最多一页在途，页内软时间片为 25 ms。每完成一条查询后检查时间片，响应明确返回 completed 与 sourceIndex。按输入顺序完成一个前缀，每条已执行查询都产生一行结果，hits=[] 也计入 completed。正常页至少执行一条；取消、整体期限或不可用状态允许提前返回。

尚未完成的查询由主线程从原矩阵重新复制并排入下一页；其旧页内查询副本由 worker 在响应后解除引用。main 的完整矩阵始终有效，因此首版无需转移未执行的局部副本回来。service 负责 preset 就绪、generation 和取消检查；worker 负责单个数据库事务与 SQL。分组准备阶段的向量服务调用 embedding API 的次数为 0。

vector_index 的 worker_protocol.ts、worker_client.ts、worker/runtime.ts 和查询实现同步更新。以上接口仅用于服务内部，首版无需新增客户端 RPC。

同时更新 worker_client.ts 的 commandTransferList 与 worker/runtime.ts 的 responseTransferList：前者转移新 ANN 页的独占向量 buffer，后者转移 readDreamVectors 返回的向量 buffer。新增协议分支和实际 transferList 一同验收。

### 5.3 Worker 命令与所有权

~~~ts
type DreamSemanticCommand =
    | {
          type: 'bisect'
          matrix: DreamVectorMatrix
          maxBatchSize: 30
          groupCount: number
          iterations: number
          seed: number
          budgetMs: number
          cancelBuffer: SharedArrayBuffer
      }
    | {
          type: 'refine'
          matrix: DreamVectorMatrix
          initial: DreamPlanLabels
          candidates: DreamCandidates
          maxPasses: number
          maxTargetGroups: number
          maxSwapPartners: number
          maxEdgeVisits: number
          maxHintEdgeVisits: number
          budgetMs: number
          cancelBuffer: SharedArrayBuffer
      }
~~~

bisect 响应返回 labels、sizes、统计及同一个 matrix.buffer。refine 响应区分：

~~~ts
type DreamRefineResult =
    | {
          outcome: 'use-initial'
          reason: 'budget-before-graph' | 'empty-graph'
          diagnostics: DreamPlanningDiagnostics
      }
    | {
          outcome: 'refined'
          plan: DreamPlanLabels
          diagnostics: DreamPlanningDiagnostics
      }
~~~

原维重评分或 CSR 构建期间也可能到期。完整图与 F_initial 尚未形成时，返回 use-initial，main 使用自己保留的合法标签；完整图形成后，返回最近验证的完整图修复结果。矩阵在 refine 阶段结束时解除引用。

明确转移顺序：

| 阶段 | 矩阵所有者 | 主线程保留内容 |
| --- | --- | --- |
| 分页读取 | 主线程 | 正文、ID/hash、矩阵 |
| bisect 执行 | Dream Worker | 正文、ID/hash |
| HNSW 查询 | 主线程 | 正文、ID/hash、矩阵、initial 标签 |
| refine 执行 | Dream Worker | 正文、ID/hash、initial 标签检查点 |
| LLM 会话 | 已释放矩阵引用 | 正文、DreamCluster[]、原有会话状态 |

refine 接收 initial.labels.slice() 与 sizes.slice()；主线程原 initial 保留可用。每条 ANN 查询通过 matrix.vectors.slice(start, end) 复制一行后转移。整矩阵采用 ArrayBuffer 转移，局部查询仅复制 D 个 Float32。转移后原所有者停止访问已分离的 buffer。Node 官方区分了 transferable ArrayBuffer 与共享 SharedArrayBuffer，见 S10。

## 6. 容量约束递归球面二分

### 6.1 为什么携带叶组预算

根节点携带 N 条记忆和 K 个最终组。每个内部节点携带 n 条记忆和 k 个最终组，保持：

~~~text
k <= n <= 30*k
~~~

k = 1 时输出该叶组。k > 1 时：

~~~text
kL = floor(k/2)
kR = k-kL
lo = max(kL, n-30*kR)
hi = min(30*kL, n-kR)
~~~

左子节点条数 nL 只能取 [lo, hi]，右边为 n-nL。这同时给两边保留足够的记录和容量。对于 N=10000、K=334，根节点 kL=kR=167，nL 的可行范围是 4990–5010。

### 6.2 每个节点的具体计算

1. 保留输入 Float32 矩阵，另以 Float64Array(N) 保存 invNorm。范数与点积使用 JS Number 累加，通过原向量乘 invNorm 得到单位方向。两阶段各自重算 invNorm，额外载荷仅 8N 字节。
2. 以固定种子和稳定行号选第一个参考点，通过有界的最远点扫描得到两个真实单位向量作为初始中心。全同向量的平局使用最小行号。
3. 计算每条记录到两个单位中心的费用：

~~~text
costL(i) = 1-dot(x_i, cL)
costR(i) = 1-dot(x_i, cR)
delta(i) = costL(i)-costR(i)
~~~

4. 按 delta 升序，再按稳定行号排序。
5. 通过前缀和，在 t ∈ [lo, hi] 中选择费用最低的切点：

~~~text
cost(t) = sum_all(costR) + prefix_sum_delta(t)
~~~

费用平局优先最接近 n*kL/k 的切点，再选更小 t，减少无意义的左右偏斜。

6. 更新两个子集的归一化和向量中心。子集和范数接近 0 时保留该侧已有的有效中心，或取该子集稳定代表点。
7. 最多执行 3 轮分配与中心更新。比较每轮更新中心后的真实球面目标 norm(sumLeft)+norm(sumRight)，保留目标最大的完整合法切分及其成员。不同轮使用不同中心，delta 前缀和只用于当轮选择切点。
8. 将两个子问题压入显式栈，继续处理。

浮点容差用于迭代停止与收益接受，按目标绝对权重和机器精度确定，例如 64*Number.EPSILON*max(1,absoluteWeightSum)。排序比较器按实际数值大小和稳定行号比较，以保持传递性；业务相关性阈值另行校准。

### 6.3 伪代码

~~~ts
function bisect(matrix, B, K, options) {
    if (matrix.entryCount === 0) return emptyPlan()
    assert(K === Math.ceil(matrix.entryCount / B))
    const invNorm = validateAndComputeInverseNorms(matrix)
    const stack = [{ indices: allOrdinals(), leafBudget: K }]
    const leaves = []

    while (stack.length > 0) {
        checkCancellationAndInitialDeadline()
        const node = stack.pop()
        if (node.leafBudget === 1) {
            leaves.push(node.indices)
            continue
        }

        const kL = Math.floor(node.leafBudget / 2)
        const kR = node.leafBudget - kL
        const lo = Math.max(kL, node.size - B * kR)
        const hi = Math.min(B * kL, node.size - kR)
        const cut = optimizeSphericalSplit(node, lo, hi, options)
        stack.push({ indices: cut.right, leafBudget: kR })
        stack.push({ indices: cut.left, leafBudget: kL })
    }

    return validateCompletePlan(leaves)
}
~~~

实际实现用一个全局 permutation Uint32Array 和子区间描述节点，减少重复切片。排序及最佳划分临时数组可复用；两个中心使用 O(D) 的临时数组即可。ID 采用字符串 < / > 的稳定序，种子转换为 uint32，PRNG 每步保持 uint32 截断。时间预算可能改变完成的修复步数；回放测试使用固定工作量预算。

### 6.4 边界与预算

- N=0：算法返回空计划；现有业务触发门槛仍为 30 条。
- 1≤N≤30：返回一个完整组，内部函数边界独立于触发门槛。
- 完整初解预算到期：返回明确的 initial-budget-exhausted 错误；调高预算或检查输入后重试。
- 全同向量仍可按稳定平局规则得到合法分组；零向量与非法分量走输入错误路径。
- 固定输入、种子和参数时，二分结果可复现。HNSW 重建可能改变候选集合，端到端复现需同时保留候选或索引 generation。

每层对原维向量进行有限轮扫描，总点积工作近似 O(ND log K)，节点内排序还产生约 O(N log N log K) 的上界成本。数据结构按 O(ND+N+KD) 的线性量级组织；这里 KD 只在需要记录所有组中心时出现，初解可用逐节点中心进一步缩减。

## 7. PGlite 与 HNSW 的落地

### 7.1 依赖版本先行

基线使用 PGlite 0.5.8 与 pglite-pgvector 0.0.9，前轮运行确认内嵌 vector 扩展为 0.8.1。pgvector 0.8.3 / 0.8.4 修复过 HNSW vacuum 相关问题，参见 S7。持久化、动态更新的主表 HNSW 采用修复后的扩展。

2026-10-22 检查官方 npm 包得到明确的升级候选：

~~~json
{
  "@electric-sql/pglite": "0.5.11",
  "@electric-sql/pglite-pgvector": "0.0.12"
}
~~~

pglite-pgvector 0.0.12 的 peerDependencies 要求 PGlite 0.5.11；包内 vector.control 的 default_version 为 0.8.7，并包含从 0.8.1 逐版本更新到 0.8.7 的 SQL。该包发布于 2026-10-21，包内容检查完成；新版本运行时兼容性和目标机性能仍需按本节验收。

同时更新 package.json 与项目实际锁文件。保持所有相关依赖锁文件与发布流程一致。

### 7.2 迁移与索引

在维护任务中对旧向量库进行冷备份，然后在隔离副本验证：

~~~sql
ALTER EXTENSION vector UPDATE TO '0.8.7';
SELECT extversion FROM pg_extension WHERE extname = 'vector';
~~~

确认实际 extversion 为 0.8.7 后，再启用持久 HNSW。仅升级 npm 包不会自动改变已有数据库的 extension 版本。

**核心 schemaVersion 保持 4，HNSW 使用独立物理索引名的 _v1 管理定义版本。** 本次增加可选索引和读取接口，主表列保持现状；已有 v3 继续走原 v3→v4。ANN ready 通过实际索引定义、indisvalid、indisready 和构建结果判断，向量事实库 ready 与 ANN ready 分别表达各自状态。

当前 maintenance.ts 会因 extension / schema 版本不符触发全量重建。此次必须先加入“已知补丁扩展原地升级”分支，并在受控迁移事务中更新 manifest.vector_extension_version 为实际值，保留原 model、dimension、generation 和向量。该分支先于原通用 mismatch→rebuild 判断执行。实际 PostgreSQL major 与数据目录兼容性在冷库副本验证；需要 major 迁移时走官方导出/导入路径并保留已有向量。

具体启动顺序为 open → 读取已安装 extension 与原 manifest → 执行已验收的 0.8.1→0.8.7 升级事务 → 重新 inspect → 原 startup reconcile。已知迁移错误需要独立类型，并在 openOwned 的通用“隔离目录、创建新库”处理之外保留旧目录，便于修复或回退。未知版本、模型与维数问题继续使用原有明确规则。

索引 DDL：

~~~sql
CREATE INDEX lm_index_memory_dream_hnsw_v1
ON lm_index_memory USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE status = 'active';

ANALYZE lm_index_memory;
~~~

索引覆盖各 preset 的 active 记忆；正文向量继续存储在同一主表。归档、删除、更新与新写入通过 PostgreSQL 的现有索引维护路径处理。

索引构建在启动对账或全量重建完成后自动触发独立维护任务，复用现有 operation gate、worker 和目录生命周期；后续启动复用已建索引。每轮 Dream 读取 ANN ready 状态，使用已建索引。维护默认单线程，maintenance_work_mem 初始为 64 MB，具体值以整机验收确定。进程关闭依照现有顺序先停止入口、排空任务，再关闭数据库。

新建库先建 schema、批量写入向量，再建立 HNSW。SQL 扩展迁移、HNSW 构建和每轮分组准备新增 embedding 调用数为 0，补丁升级保留既有正文向量。原有启动维数探针会调用一次 embedding，验收时单独计数。更换 embedding 模型或维数继续走项目原有重建逻辑。

### 7.3 普通召回明确精确查询

在同一主表增加 HNSW 后，现有 ORDER BY embedding <=> vector LIMIT 查询可能选择 ANN。为保持普通召回语义，queryVectorIndexKnn 改为显式精确路径。首版采用 scored CTE，仅物化 ID 与标量距离：

~~~sql
WITH scored AS MATERIALIZED (
    SELECT memory_id, embedding <=> $vector::vector AS distance
    FROM lm_index_memory
    WHERE /* 复用现有 preset/status/conversation/type/consolidated 条件 */
)
SELECT memory_id AS "memoryId",
       1 - distance AS "cosineScore"
FROM scored
ORDER BY distance ASC, memory_id ASC
LIMIT $limit;
~~~

$vector 与 $limit 在实际实现中使用 PostgreSQL 的编号参数。CTE 计算全部过滤候选的距离，只保存 ID 和 distance；条件筛选仍可使用普通索引。距离排序发生在物化的标量结果上。hybrid 的关键词加分、阈值和结果合并继续复用原逻辑。

该精确路径的成本需要一并验证，尤其是过滤结果很大的查询。EXPLAIN 中应显示普通过滤及 CTE Scan / 排序，ANN 索引不得承担普通召回的距离排序。精确结果同时覆盖 active、archived、all 及现有 conversation 条件。

### 7.4 Dream 专用 ANN 查询

每页在向量 worker 内逐条查询，每条查询的 EXPLAIN 与 SELECT 共用一个短事务，使用 transaction-scoped 设置：

~~~sql
SET LOCAL hnsw.ef_search = 40;
SET LOCAL hnsw.iterative_scan = 'strict_order';
SET LOCAL hnsw.max_scan_tuples = 2000;
SET LOCAL hnsw.scan_mem_multiplier = 1;
SET LOCAL work_mem = '4MB';
~~~

~~~sql
SELECT memory_id AS "memoryId",
       content_hash AS "contentHash",
       1 - (embedding <=> $1::vector) AS "cosineScore"
FROM lm_index_memory
WHERE preset_id = $2
  AND status = 'active'
  AND memory_id <> $3
ORDER BY embedding <=> $1::vector, memory_id ASC
LIMIT $4;
~~~

首轮 limit = min(20, N-1)，目标保留 q = min(10, N-1)。generation 在同一 worker 请求的执行边界核验。返回后主线程按以下条件接收候选：

- 属于固定 target 集合，并且与 source 不同；
- 返回的 contentHash 与捕获正文一致；
- 同一 source 的候选 ID 唯一；
- 首轮最多 20 条，一次补查最多 40 条，去重并集最多 60 条，存入 M=64 的行缓存。

不足 q 的行最多重试一次：ef_search = 100、limit = min(40, N-1)，仍受同一候选阶段期限和扫描上限控制。重试查询向量继续来自冻结矩阵。第二次查询的结果与第一次按 ID 去重合并。最终 top-q 在 Dream Worker 中按冻结原向量重评分后选出。

pgvector 的过滤可能发生在 ANN 扫描之后；iterative scan 能扩大扫描，但结果条数与召回仍受实际数据和预算影响，见 S8。max_scan_tuples 是近似扫描控制，首次扫描及数据库执行延迟也应纳入测量。

### 7.5 队列、查询计划与候选不足

保持现有一个 PGlite 实例和一个向量 worker FIFO。主线程只提交一个至多 4 条查询的小页，每完成一次 EXPLAIN+SELECT 检查 25 ms 软时间片；等待结果后让出事件循环，再提交下一页。普通召回与写入可在页间排入队列。实际页大小通过在线召回尾延迟确定。

上线前对 100%、10%、1% preset 占比及归档混合场景执行 EXPLAIN (ANALYZE, BUFFERS)。运行时的首版实现对每条候选 SQL 在同一短事务内先执行 EXPLAIN (FORMAT JSON)，确认扫描实际使用 lm_index_memory_dream_hnsw_v1 后再执行 SELECT。基础查询与补查分别核验各自实际参数。若计划选择精确过滤扫描，返回 plan-exact，使用 initial。EXPLAIN 的额外开销计入候选预算，后续可单独验证计划缓存及失效策略。

全量查询前先选取分布于初始各组的至多 32 条确定性探测，成功结果复用。若探测已出现计划不符或补查后短行，可以提前使用 initial。普通 exact 查询及原有写入继续正常服务。

首版采用保守的图启用条件：

1. 本轮全部 N 行已经完成至少一次候选查询。
2. 每行取得 q 个通过快照筛选的唯一候选。
3. 运行 generation 保持一致，候选数据结构验证通过。

这三个条件衡量候选结构完整度；精确近邻召回另测。候选阶段到期或覆盖条件不足时使用完整 initial，记录 queriedRows、fullCandidateRows 与原因。后续若允许部分图，需独立验证缺边偏差后设置准入条件。

索引主体 dirty、worker 失效等沿用项目已有致命错误语义。ANN 未构建、候选预算不足和候选覆盖不足属于可使用 initial 的明确状态。

## 8. 稀疏图与跨组修复

### 8.1 构图

在 Dream Worker 内用冻结原维度矩阵重新计算全部候选点对余弦，再按分数与稳定行号保留每点 top-q。SQL 分数仅用于候选发现和诊断，最终边权统一来自本轮矩阵。

~~~text
cos(i,j) = dot(raw_i, raw_j)*invNorm[i]*invNorm[j]
w(i,j) = max(0, clamp(cos(i,j), -1, 1))
~~~

该公式把正余弦作为相对关联强度，0 是数值裁剪边界。实际“应该合并”“属于同一事实”等判断继续由模型和质量标注决定。

每行保留最多 q 条有向候选，取无向并集：i 找到 j 或 j 找到 i 即可构成一条无向边。每个无序点对只存一次权重，再写成两条 CSR 邻接项。

CSR 保存 Float32 权重，修复器使用 JS Number 累加这些已冻结的权重。图目标以实际存储值为准。用于伙伴筛选的有向 top-q ID 与对应权重保留到修复结束。

实现可使用两个 Uint32 端点数组，对 (min(i,j), max(i,j)) 排序并去重，再生成 CSR。整个过程按 O(Nq) 的数组规模分配。无向边数 E≤Nq，CSR 邻接项数≤2Nq。并集图允许单点度数超过 2q，总边数界仍成立；修复预算按实际邻接访问量计数。

q=10、N=10000 时，CSR 载荷上界约：

~~~text
4*(N+1) + 2*N*q*(4+4)
= 1,640,004 bytes
≈ 1.64 MB
~~~

这是 CSR 数组自身的大小；构图临时数组、候选数组、向量矩阵、正文和数据库各自计量。

### 8.2 修复目标

在一张固定图上最大化同组边权之和：

~~~text
F = sum over undirected edges (i,j):
        w(i,j) * [label(i) == label(j)]
~~~

图固定后才开始修复，initialObjective 与 finalObjective 使用同一组边计量。接受严格正收益的操作；数值容差按浮点运算误差设置。

定义 g(u,G) 为 u 到组 G 所有邻居的边权和。

**单点移动**：u 从 A 移到 B，需要 size(A)>1 且 size(B)<30。

~~~text
gain_move = g(u,B)-g(u,A)
~~~

**两点交换**：u∈A、v∈B、A≠B，交换保持两个组大小。

~~~text
gain_swap =
    g(u,B)-g(u,A)
  + g(v,A)-g(v,B)
  - 2*w(u,v)
~~~

减去 2*w(u,v) 是交换公式的必要项：交换前后 u、v 始终属于不同组。

10,000 条与 334 组仅有 20 个总空位；N 恰好被 30 整除时全部组都满。**首版必须实现 swap，才能在组已满时改善边界。**

### 8.3 有界候选与执行方式

维护 labels、sizes、members[30*K]、slotOf[N] 与 used[N]。members 保存每组的成员槽；move 使用尾槽删除和追加，swap 直接交换原槽，统一更新行号与标签。

每个锚点 u 完整扫描自己的 CSR 行，按当前标签累加到可复用的 O(K) 临时桶；只清理本轮触及的桶。选跨组关联最高的至多 3 个候选组。

对每个候选组：

1. 容量允许时计算一次 move。
2. 遍历该组全部至多 30 个成员，使用每个成员自身的有向 top-q 边，估计其“移到 A 的关联减去留在 B 的关联”，选提示收益最高的至多 4 个交换伙伴。该步骤允许选中与 u 没有直接边的成员。
3. 按当前标签完整扫描伙伴邻接行，计算精确 swap 收益。
4. 选择可行且收益最大的操作；平局按目标组和行号稳定决定。
5. 原子更新本次操作涉及的标签与 sizes，继续下一个锚点。

首版采用在线更新，锚点按稳定行号升序遍历。评估发生在当前标签状态，接受后立即更新；同一轮内的后续收益随之重新计算。每遍把 used 清零，每个节点最多参加一次被接受的操作，作为锚点或伙伴均适用。用原子步骤表达算法状态提交，实际执行仍在单个 JS Worker 内。

最多执行 3 遍锚点扫描；一遍没有正收益操作即可停止。CSR 搜索访问预算为 100*N*q；伙伴提示访问另计，上界为 3*N*3*30*q，N=10000、q=10 时最多 2700 万次标量边访问。提示只用于选择伙伴，接受操作使用完整 CSR 收益。

任一完整收益计算开始前预留对应行的访问预算；途中触及期限或取消时放弃该未提交操作。已经提交的每一步保持覆盖、容量和非空组成立。每遍结束和预算停止后使用全图重算 F，保留目标最好的完整 checkpoint。为这些 O(N+E) 检查预留结束预算；检查发生在结果返回之前。数值或状态错误导致目标异常下降时报告故障，沿统一错误语义处理。

只有一张图上的 F 单调提升得到算法保证。真实同事实配对率、矛盾整理召回和模型产出质量通过独立样本验收。

### 8.4 后续可增加的修复

第一轮真实数据评估若发现 move / swap 经常卡在局部结构，可追加两个组的联合重分：每次最多 60 条，允许联合边界重分后仍保持两组、每组最多 30 条，并用同一图目标验收正收益。它作为独立改进，不纳入首版必须完成的模块。

## 9. 预算与停止语义

### 9.1 初始参数

以下是实现起点，属于工程预算；目标机实测后再定最终默认值。

| 参数 | 首版值 | 含义 |
| --- | ---: | --- |
| maxBatchSize | 30 | LLM 分组条数上限 |
| groupCount | ceil(N/30) | 初解与修复共同保持的组数 |
| splitIterations | 3 | 每个二分节点迭代上限 |
| vectorReadPageSize | 256 | 每页读取向量条数 |
| neighborCount / candidateWidth | 10 / 64 | 重评分后的近邻数 / 查询候选缓存行宽 |
| HNSW m / ef_construction | 16 / 64 | 索引构建参数 |
| ef_search | 40 | 首轮近邻查询 |
| retryEfSearch | 100 | 不足行的一次重试 |
| ANN pageSize / inFlight / sliceMs | 4 / 1 / 25 | 数据库后台工作粒度与软时间片 |
| maxTargetGroups / maxSwapPartners | 3 / 4 | 单锚点修复范围 |
| maxRefinePasses | 3 | 局部修复遍数 |
| maxEdgeVisits | 100*N*q | CSR 搜索访问预算；复核与提示访问分别计量 |
| initialBudgetMs | 30000 | 初解计算软期限 |
| candidateBudgetMs | 120000 | 候选阶段软期限 |
| refineBudgetMs | 20000 | 构图、重评分与修复共同预算 |
| overallPlanningBudgetMs | 180000 | 获得规划执行权后至标签完成 |
| maxNumericWorkingSetBytes | 128 MiB | 数值数组分配前的预计峰值上限 |
| seed | 7 | 固定可复现起点 |

整体期限包含正文/向量读取与排程；排队等待时长单独记录。各阶段使用 min(自身期限, 整体剩余期限)。开始候选前预留最多 20 秒给 refine；候选阶段达到可用截止时间即可使用 initial。

时间预算以 monotonic clock 计算，主线程传递剩余 budgetMs，Worker 在本地开始计时。数据库在途操作完成时间可能超过软期限，实际超出量需要测量。

### 9.2 取消实现

每个任务分配一个只含取消状态的 SharedArrayBuffer，主线程监听 AbortSignal 后用 Atomics.store 写入取消标记。Worker 在循环边界及有界数量的点积/邻接访问后 Atomics.load 检查。

选择初始检查粒度，使实测 CPU 阶段取消延迟 p95≤250 ms。一个长同步 Worker 任务无法靠普通 cancel 消息即时打断；共享取消位可以在同步计算中被读取。设置 Worker resourceLimits 只能约束相应 V8 资源，TypedArray、WASM 与全进程 RSS 仍需独立监测。

ANN 页间检查 AbortSignal。当前在途 SQL 按实际 PGlite 能力完成或取消后，停止提交后续页；仅拒绝外层 Promise 不算计算已停止。首版避免以 Promise.race 冒充数据库取消。

### 9.3 状态处理表

| 情况 | 行为 |
| --- | --- |
| 完整 initial 已产生，ANN 未就绪或预算到期 | 使用 initial，记录阶段与原因 |
| N 行候选覆盖不足 | 使用 initial，记录候选完整度 |
| refine 时间或边访问预算耗尽 | 返回最近完整提交的合法 labels |
| 用户取消或服务停止 | 结束整轮后续操作，排空在途任务 |
| 向量缺失、hash 不匹配、generation 切换 | 结束准备并报告具体索引/输入错误 |
| initial 到期且尚未完整完成 | 结束准备，LLM 调用次数为 0 |
| Worker 异常、协议错误、分组覆盖或容量验证失败 | 按现有故障与任务终态处理 |
| 工具事实已提交、索引同步失败 | 保留既有 factsCommitted 覆盖登记和对账行为 |

## 10. 工作流接线与正文一致性

### 10.1 full.ts 的建议顺序

复用 SerialTaskQueue，在 Dream service 实例上使用固定规划队列键，跨 preset 串行化准备阶段：

~~~ts
await planningQueue.run('dream-planning', async () => {
    signal?.throwIfAborted()
    entries = stableSort(await repository.listDreamEntriesByPreset(presetId))
    state = createDreamSessionState(entries.map(e => e.id))

    model = await createConfiguredModel()
    validateExistingDreamModelBudget(model)

    state.clusters = await clusterer.buildClusters(
        presetId, entries, logger, signal
    )
})

signal?.throwIfAborted()
const persona = await presetPersona.resolveOrGenerateCardText(...)
const speakers = await mutations.ensurePresetSpeakersCoverage(...)
const tools = createDreamSessionTools(...)
await runDreamSession({ state, tools, model, ..., signal })
~~~

上面是顺序规格，实际沿用现有类型和错误处理。把失败结果生成留在 full.ts 统一入口；目标集合建立后即便模型或规划失败，仍能报告原始覆盖范围。

planningQueue 的整个 Promise 放入现有 try/finally 生命周期。排队取消或正文读取失败可能发生在 state 创建之前，这类错误交由已有 job_runner 记录失败；目标捕获之后的错误才基于 state 计算覆盖。避免在尚未捕获目标时调用覆盖函数或报告“全部完成”。

停止期间，已排队任务获调度时首先检查取消并结清自己的任务状态，正文和向量读取发生在该检查之后。coordinator 继续排空任务，随后关闭 Dream Worker 与向量服务。

### 10.2 向量和正文的一致性

复用 createMemoryContentHash(entry.content)。Dream 专用向量查询在同一条 SQL 中返回向量、content_hash 与 status，按页附带 model / dimension / generation。

首版对不匹配立即报告准备失败，保持该轮固定目标；维护修复或数据稳定后重新发起任务。这样边界明确，避免在长时间准备中不断追赶实时写入。

HNSW 候选来自实时主索引；候选接收时限定本轮 ID 与正文 hash，边权使用冻结矩阵重算。期间新增的 ID 与正文已经变化的候选被筛除。generation 表示向量索引代际，普通增量写入仍由 contentHash 判断。

### 10.3 保留现有工具会话语义

首版继续使用启动时捕获的正文输入、既有 active/preset 检查和 mutation 队列。当前项目尚未对所有模型可见字段实施 compare-and-swap；本次算法改造保持这项现有并发语义。

需要严格处理“模型读取后，外部用户更新了同一条记录”的场景时，另开版本一致性改造：为模型可见字段建立 revision，在 mutation 队列和事实事务内核验期望版本，覆盖 merge / split 全部来源，并明确冲突延期与覆盖统计。仅检查 updatedAt 或仅在发批前检查，均需要额外分析竞争窗口。

合并和拆分生成的新 ID、跨批引用、已处理记录的再次合法操作、索引同步失败后的覆盖登记全部保留。覆盖计数按原始 ID 的 Set 统计；模型对同一活跃记录的合法再次操作可以继续发生。

## 11. LLM 输入容量与批次数

首版沿用现有规则：

- 输出预算取模型配置的正数 maxTokens，默认 4096。
- 模型最大上下文扣除输出预算后至少有 200,000 输入 tokens。
- 最近一次有效供应商 input_tokens 达到 200,000 时，压缩更早批次。
- 完整 prompt 继续经 model.cropMessages 的现有容量检查；保留全部当前批正文。
- batch 的模型可见字段继续使用 renderMemoriesForModel 与统一 prompt_format。

模型输入包含正文之外的类型、摘要、关键词、时间、speaker 等字段，正文 embedding 的输入范围与完整 Dream prompt 分别计算。30 条上限不能直接转换为 token 上限。

**token 自动拆批作为独立小改动提交。** 它在某批首次 LLM 请求发出前，通过现有模型计数接口检查完整候选请求；若该批导致容量超出，尝试将该批拆成两个非空子批并重新计数。预检通过后再正式 startBatch，并登记该执行子批的 available ID。拆分优先保持已有强关联，保持每条原始 ID 一次覆盖。初始 334 组可变为更多执行批，分别记录 plannedGroupCount 和 executionBatchCount。

该小改动保留既有 200k 压缩触发条件。已有历史和工具本身已经耗尽预算、单条完整记录仍无法容纳、或已经发出过 LLM 请求的当前批超限时，沿用明确的容量错误处理。更改压缩时机、压缩当前批、适配小上下文模型各自另设行为与验收。

首版上线可继续使用当前完整输入检查；token 拆批的完成情况需在版本说明中明确。

## 12. 资源账本与实际性能边界

### 12.1 可直接计算的数组成本

| 数据 | 10,000×768 | 10,000×1024 |
| --- | ---: | ---: |
| 一份 Float32 正文矩阵 | 30.72 MB | 40.96 MB |
| initial labels 与 sizes | 约 0.041 MB | 约 0.041 MB |
| M=64 候选 ID 与 counts | 约 2.57 MB | 约 2.57 MB |
| invNorm 与保留 top-q 权重 | 约 0.48 MB | 约 0.48 MB |
| 无向并集 CSR 载荷上界 | 约 1.64 MB | 约 1.64 MB |
| 4 条 ANN 查询向量副本 | 约 0.012 MB | 约 0.016 MB |

以上采用十进制 MB，尚需加入排序、去重、分区、中心临时数组和 JS 元数据。10,000 条时将算法数值工作集按约 64 MB 目标控制，并在真实实现上记录阶段峰值。这个目标描述新增数组工作集，整进程内存由 PGlite、WASM、Koishi、正文、模型历史及其他插件共同决定。

分配前依据实际 N、D、M、q 计算各阶段同时存活的向量、标签、候选、CSR、排序与最佳划分数组字节，检查长度乘积为安全整数，且保守峰值≤maxNumericWorkingSetBytes。首版该上限取 128 MiB，作为实现起点；超出时在数值分配前报告 numeric-budget-exceeded。更大规模通过显式调整预算及目标机验收支持，10,000 条成本表只用于对应规模。该预算约束新增数值数组，正文和整个服务内存继续独立计量。

矩阵在主线程与 Dream Worker 之间转移，任何时刻一份完整矩阵拥有一个所有者。全部向量读取完成后释放分页 Map / 行数组；LLM 阶段前释放矩阵和图引用。V8 / WASM 的内存回收与 RSS 回落时间由运行时决定。

### 12.2 前轮测量可以支持什么

前轮合成数据测量使用 N=10000、D=1024，单 JS / 数据库执行线程，宿主实际配额为 8 CPU / 8 GiB：

- 重叠话题样本的容量二分研究原型初解约 0.591 秒。
- 旧依赖下 HNSW m=16、ef_construction=64 建索引约 13.236 秒。
- 同样本 10,000 次 top-10 查询约 33.927 秒，100 个抽样查询对 SQL 精确 top-10 的 recall 为 99.9%。
- HNSW 索引磁盘大小约 81.93 MB。
- 临时进程整个生命周期峰值 RSS 约 1.202 GB，峰值已经出现在空数据库初始化阶段。

这些数值作为工程路线可行性证据。新依赖、每行额外候选、worker IPC、快照筛选、最终修复、真实语料、多 preset 和完整 Koishi 服务都需要重新计量。768 维的数组成本可计算；本方案不以维数比例推算未经测量的秒数。

### 12.3 目标机验收

分别使用真实 2 CPU / 2 GiB、2 CPU / 4 GiB 配额运行完整服务，记录 cgroup、Node 与依赖版本。首次建库、旧库迁移、索引构建、热库 Dream、正常召回和连续写入分别测量。

建议第一轮上线门槛：

| 指标 | 2 GiB 场景的起始门槛 | 说明 |
| --- | --- | --- |
| 运行结果 | 无 OOM，全部硬约束通过 | 必须项 |
| 整个部署 cgroup 峰值 | ≤1.6 GiB | 为系统与突发留约 20% 余量；按实际部署组成核算 |
| 主事件循环延迟 p95 | ≤50 ms | 正常业务并行负载下测量 |
| 普通召回 p95 | 相对基线增加≤20%，且满足现有业务 SLO | 两个条件同时检查 |
| CPU 阶段取消 p95 | ≤250 ms | 数据库在途阶段另报 p95/p99 |
| 热库规划时长 | 尝试在 180 秒预算内完成 | 记录预算退回比例及最终阶段 |
| 候选读取 embedding 调用数 | 0 | 在测试 stub 与真实日志中核验 |

这些门槛是建议的验收目标。若 2 GiB 的完整服务基线或迁移峰值本身超预算，先启用容量二分，并对 PGlite 初始化、索引维护或部署内存单独调整；不能用算法数组几十 MB 推导整机已经达标。

## 13. 文件改动清单

建议在现有 dream 目录内新增 semantic 子目录，保持内部职责集中。

| 文件或目录 | 实施内容 |
| --- | --- |
| dream/clustering.ts | 编排输入、初解、候选、修复、最终适配；接收 signal |
| dream/semantic/types.ts | planner 内部参数、结果、候选及 CSR 类型 |
| dream/semantic/bisect.ts | 容量预算二分与确定性平局 |
| dream/semantic/graph.ts | 原维重评分、无向去重、CSR 构建 |
| dream/semantic/refine.ts | 有界 move / swap 与收益计算 |
| dream/semantic/validate.ts | 独立覆盖、容量、尺寸与标签检查 |
| dream/worker/protocol.ts、client.ts、entry.ts | 新命令、transfer、共享取消、进度及错误 |
| dream/full.ts | 规划队列、目标快照、早期模型预算、signal 传递 |
| dream/coordinator.ts、job_runner.ts | 必要的排队、排空和诊断接线 |
| contracts/vector_index.ts | Dream 专用 provider |
| vector_index/service.ts | 直向量接口、就绪与 generation 检查 |
| vector_index/worker_protocol.ts、worker_client.ts、worker/runtime.ts | 对应内部协议 |
| vector_index/worker/queries.ts | Dream vectors/ANN、普通 exact 查询 |
| vector_index/worker/schema.ts、database.ts | 保持核心 schema v4，受控扩展升级及 manifest 同步 |
| vector_index/worker/dream_ann.ts | 独立索引定义、catalog 状态、计划检查和短页 ANN |
| vector_index/maintenance.ts、rebuild.ts | 独立建索引、重建顺序和维护验收 |
| contracts/workflows.ts、src/index.ts、app/living_memory_service.ts | 单个配置字段及依赖装配 |
| docs/dream-session-plan.md、docs/vector-index.md | 当前运行规则及维护行为 |
| AGENTS.md | 新目录与文件职责 |

优先保留现有 Worker 构建入口。若将 dream-hdbscan-worker.mjs 重命名，同一提交更新 scripts/build-workers.mjs、worker_artifacts.ts、客户端定位与打包测试。

旧 partitioning / hdbscan 代码在基线对照和新算法验收完成后，根据全仓引用移除或转入离线研究 fixture。生产默认路径只保留选定实现；旧算法通过固定历史版本参与对照。

## 14. 分阶段提交顺序

### PR 1  容量二分与资源边界

内容：稳定目标排序、Dream 专用向量读取及 hash 校验、bisect Worker、覆盖验证、signal、规划串行队列、原接口适配。

完成标准：

- 给定 N 输出 ceil(N/30) 个非空组，所有组≤30，逐 ID 恰好覆盖一次。
- 10,000×768 与 10,000×1024 的数值工作集和取消路径有记录。
- 完整 initial 可直接接现有 Dream 会话，分组准备新增 embedding 调用数为 0。
- 原有工具事务、factsCommitted、覆盖和会话测试保持原语义。
- 初解单独通过锁定的业务质量门槛，达到作为正式执行结果的要求。

此阶段可以单独交付。dreamSemanticRefinement=false。

### PR 2  依赖升级、主表 HNSW 与专用候选接口

内容：先接普通 exact 路径，再成对升级 PGlite 包、旧库副本升级、extension 实际版本检查与 manifest 同步、active HNSW、独立维护入口和 ANN 小页接口。核心 schema 保持 v4。

完成标准：

- 新建库、基线旧库、重开库均能查询和写入。
- 实际 vector extversion=0.8.7，manifest 与查询能力一致。
- 普通召回结果与精确基线一致。
- 多 preset / archived / 新增 / hash 变更场景下候选筛选正确。
- EXPLAIN、查询不足率、召回率、在线干扰和维护峰值有数据。

候选接口先用于诊断，与初解质量分别验收。

### PR 3  稀疏图与局部修复

内容：候选收集、覆盖门槛、CSR、move / swap、预算退回、统一 diagnostics。

完成标准：

- 小图穷举重算验证每次 gain，尤其是 swap 的 -2*w(u,v)。
- 每次接受操作后容量与完整覆盖成立。
- 固定图下 finalObjective≥initialObjective。
- 无空位场景仍能通过 swap 改善测试构造。
- 部分候选、候选截止、refine 截止和用户取消各走明确路径。
- 真实语料的独立质量指标达到第 15 节门槛。

该阶段完成后启用完整路线，保留配置关闭 refinement 的可用初解路径。

### PR 4  完整服务验收与发布切换

内容：2 GiB / 4 GiB 配额验证、迁移演练、长期增删后 HNSW 维护、文档、日志和发布默认值。

完成标准：资源门槛、业务质量门槛及当前仓库发布检查均通过。正式默认切到 dreamSemanticRefinement=true。

### 独立后续提交

根据真实数据决定优先级：token 拆批、两组联合重分、写入 revision / CAS、正文按批 hydrate、断点续跑与操作幂等。每项单独描述业务语义和验收，不依赖“顺手改完”。

## 15. 测试与质量验收

### 15.1 必要算法用例

| 用例 | 核验目标 |
| --- | --- |
| N=0、1、29、30、31、59、60、61、10000 | 空输入、非空组、边界 K 与容量 |
| 所有向量相同 | 稳定平局与完整覆盖 |
| 互相抵消的方向、零中心 | 中心更新处理 |
| 零向量、NaN、维数不一致 | 输入错误被清楚定位 |
| 全满组 | swap 可执行、move 容量检查正确 |
| 一条跨组桥边、星形高入度图 | swap 公式与实际边访问预算 |
| 同一候选双向出现 | 无向去重与边权计数正确 |
| initial/refine/ANN 分别到期 | 明确区分合法结果与未完成结果 |
| Worker 转移后再次读取原 buffer | 所有权测试能捕获错误使用 |
| 初解 checkpoint 与 refine buffer | refine 转移后 initial 仍可用 |

数值 gain 的验证使用独立的全图目标重算，不用与被测实现相同的增量公式充当真值。

### 15.2 必要集成用例

1. 捕获正文之后、读取向量之前改变正文，hash 不匹配时在模型前报告错误。
2. 候选包含其他 preset、归档项、新写入 ID 与过期 hash，全部按本轮规则筛选。
3. 索引 generation 在页间改变，准备阶段退出。
4. 服务停止时存在排队规划、CPU 工作、ANN 页和已提交工具事务，各自正确结束。
5. 普通召回 active / archived / all、conversation、type、关键词加分与原精确结果一致。
6. 当前模型历史、200k usage 压缩、完整输入检查、工具调用配对与覆盖统计继续满足原测试。
7. factsCommitted 分支仍保留成功覆盖并触发既有索引对账。
8. 新建、升级、重开、删除/归档/更新后索引查询与维护均通过。

既有测试迁移重点：dream-clustering.spec.ts 的业务约束保留，依赖“必须 HDBSCAN/全局噪声”的实现断言改为新算法约束；dream-session、dream-workflows、dream-repository、indexed-memory-mutations 的业务语义继续保留。

### 15.3 候选与分组质量分别测

对照组固定为三个：

- 基线旧分区 + HDBSCAN；
- 新容量二分 initial；
- 新容量二分 + HNSW + move/swap。

相同正文快照、相同 embedding、相同 batch cap、相同模型与提示词条件下比较。先只比规划，再在较小代表集上比 LLM 结果。

候选指标：对至少 200 个分层抽样查询做全候选精确 top-10，记录平均 recall@10、低分位召回、候选不足率，以及各 preset 占比和主题密度分层。近浮点边界采用相同精确计算与排序口径，并记录接近边界的差异。

分组指标：

- top-10 同批率：精确近邻中与该点同组的比例；
- 标注关系同批率：重复事实、补充事实、可合并描述、时间冲突等应该共同查看的成对关系；
- 无关混入率：人工抽样评估组内明显无关的记忆比例；
- 组数、组大小、孤立或弱关联点分布；
- initial 与 refined 的同一图目标增益。

LLM 指标：人工认可的合并/更新/保留/归档结果、错误合并率、遗漏的高价值关系、输入/输出 tokens、实际模型调用数、整体耗时。

首轮发布建议：candidate 平均 recall@10 目标≥95%；initial 自身达到锁定的业务质量门槛，refined 在代表语料的标注关系同批率至少保持 initial 水平，并且相对旧实现有可解释收益；错误合并率符合项目业务容忍度。具体质量阈值在标注集建立后锁定，结构正确和图目标提升不能替代业务质量。

预算退回会把 initial 直接交给 LLM，因此 initial 的独立质量验收属于发布条件。若 initial 尚未达标，PR 1 继续用于影子评估，正式发布等待改进；完整优化版本通过验收也不自动授权使用未达标初解。

同批成对关系存在容量可达性限制：一个超过 30 条的主题，所有两两关系无法同时处于唯一的一批。对“可同时容纳的关系集合”和超大主题分层报告，避免把结构性上限归咎于实现。

### 15.4 发布前命令

按仓库 AGENTS.md，测试、类型与构建检查集中在版本更新前执行。此次交付是实施规格，以下命令是开发完成后的门槛：

~~~sh
git diff --check
yarn lint
yarn test
yarn atsc -p tsconfig.json --noEmit
yarn build:server
~~~

若配置或展示改动涉及客户端，再执行对应 client / 全量构建。正确性测试、目标机负载验收与真实语料质量评估各自产出记录。

## 16. 日志与上线回退

### 16.1 诊断字段

统一通过 LivingMemoryLogger 记录：

- jobId、presetId、plannerVersion、N、D、K、seed；
- embeddingModelId、indexGeneration、实际 vector 扩展版本；
- queueWaitMs、readVectorsMs、initialMs、candidateMs、refineMs；
- queriedRows、fullCandidateRows、短候选行比例、重试行数、E；
- acceptedMoves、acceptedSwaps、edgeVisits、F_initial、F_final；
- 实际阶段 initial/refined、stopReason、plannedGroupCount；
- 正文内容字节估计、各类 TypedArray 字节数、进程及部署峰值测量；
- executionBatchCount、模型请求数、压缩次数、覆盖结果。

正文大小采用实际序列化字节数或明确口径的 UTF-8 字节估计；它用于比较，不等同于 V8 字符串堆占用。隐私正文与完整向量继续遵循现有日志策略。

### 16.2 两层回退

**算法开关回退**：将 dreamSemanticRefinement 设为 false，新任务使用完整容量二分。既有任务通过正常停止与排空处理。该开关减少候选/修复工作，已建索引仍由数据库维护；需要释放索引磁盘和维护成本时，另走受控维护步骤删除 ANN 索引。

**依赖或数据库迁移回退**：关闭任务入口并排空，配对恢复升级前依赖锁与冷备份向量库。事实库仍是权威数据；备份之后的事实变更通过原有 reconcile / rebuild 重新同步。旧二进制与升级后的数据库文件组合需经过明确兼容性验证后使用。

迁移验证失败时保留旧库副本及原始事实，容量二分阶段可以先独立交付；持久 HNSW 功能待运行时与维护测试通过后开启。

## 17. 实施者的第一步

从 PR 1 开始，先完成以下一条闭环：

**现有正文快照 → hash 匹配的连续 Float32 矩阵 → Worker 容量二分 → 独立覆盖/容量验证 → 原 DreamCluster[] → 原会话。**

这个闭环通过后再加入 PR 2 的 HNSW，随后加入 PR 3 的跨组修复。每一步都能运行、测量和定位问题；最终是否默认启用 refinement 由真实质量和目标机资源验收决定。

## 18. 来源与证据

### 项目源码

S1. [固定源码与依赖基线](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/tree/734123e9e123abd6d51f425735fabe436fb3a918)，版本 0.28.0。  
S2. [Dream 分组实现](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/734123e9e123abd6d51f425735fabe436fb3a918/src/service/workflows/dream/clustering.ts)。  
S3. [Dream 全量入口](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/734123e9e123abd6d51f425735fabe436fb3a918/src/service/workflows/dream/full.ts)。  
S4. [Dream 当前会话规则](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/734123e9e123abd6d51f425735fabe436fb3a918/docs/dream-session-plan.md)。  
S5. [向量查询](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/734123e9e123abd6d51f425735fabe436fb3a918/src/service/vector_index/worker/queries.ts)与[向量 schema](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/734123e9e123abd6d51f425735fabe436fb3a918/src/service/vector_index/worker/schema.ts)。  
S6. [正文 embedding 生成](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/734123e9e123abd6d51f425735fabe436fb3a918/src/service/vector_index/embedding.ts)与[项目实施规范](https://github.com/Procyon-Nan/koishi-plugin-chatluna-livingmemory/blob/734123e9e123abd6d51f425735fabe436fb3a918/AGENTS.md)。

### 官方技术资料

S7. [pgvector CHANGELOG](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md)：0.8.3、0.8.4 的 HNSW 维护修复，2026-10-22 核验。  
S8. [pgvector HNSW 与过滤说明](https://github.com/pgvector/pgvector#hnsw)及[iterative scans](https://github.com/pgvector/pgvector#iterative-index-scans)。  
S9. [PGlite API](https://pglite.dev/docs/api)：事务、查询与实例行为。  
S10. [Node.js 22.13 Worker threads](https://nodejs.org/download/release/v22.13.0/docs/api/worker_threads.html)：ArrayBuffer 转移和共享内存。

另参阅 [PostgreSQL MATERIALIZED CTE](https://www.postgresql.org/docs/18/queries-with.html)、[ALTER EXTENSION](https://www.postgresql.org/docs/18/sql-alterextension.html)与 [PGlite 升级路径](https://pglite.dev/docs/upgrade)，分别支撑显式精确查询、扩展升级脚本链和数据库格式升级处理。

### 升级包核验

S11. [pglite-pgvector 0.0.12 官方 registry 元数据](https://registry.npmjs.org/@electric-sql/pglite-pgvector/0.0.12)。核验时间 2026-10-22 07:51 UTC；peer PGlite=0.5.11；包内扩展 default_version=0.8.7；包含 0.8.1→0.8.7 的升级链。

官方 tgz SHA-256：

~~~text
09489ce9967cab2856e50114507bc1444049347182fadf540c5fe9c03d8403d5
~~~

包内容与安装后的数据库实际 extversion 分别验收。该版本尚未在本次实施方案任务中运行迁移或性能测试。

### 前轮规模研究

S12. 已交付的 Dream_Semantic_Batching_Research_2026-10-22.docx 与 Dream_Research_Reproducibility_2026-10-22.zip。后者的 scale/README.txt、probe_2.json，以及 pglite_scale/README.txt、default.json、boundary-check.json 保存数据生成、精确口径、配置、查询计划与资源测量。第 12 节引用其中单次合成实验，实际低资源服务与最终修复质量由本方案第 15 节补齐。
