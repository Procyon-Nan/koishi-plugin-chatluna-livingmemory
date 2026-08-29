# CHANGELOG

## 2026-08-29 version:0.16.1

- pending: 更新插件版本至 0.16.1。
- 67b8557: 为普通记忆增加稳定用户关联，统一 ChatLuna 与 Character 的全局昵称解析，并将用户画像生成改为依据稳定用户键精确选择来源记忆。
- 445c6f7: 召回与画像的历史加载先按 recallHistoryWindowRounds 切窗再转换，不再全量转换，并避开 ChatLuna infiniteContext 压缩摘要等无 id 历史导致的召回退化；Character 侧同步补齐切窗。
- fc229ef: 说话人解析跨轮缓存并复用平台查询结果，缓存键含平台防互串，失败条目不缓存、下一轮重试。
- 25cb9a3: 删除 MemoryScope 的死字段 speakerName。
- c0df797: Dream 记忆合并回归纯语义判定，合并产物的 speakerKeys 取全部源记忆的并集。
- e60adbd: buildMemoryEntry 说话人键改为必填参数，调用点显式传值。
- f565bf3: 删除 speakerKeys 归一化的多余强转。
- 5504f35: scope 构建函数还原为同步。
- e0cb2b1: 导入条目行构建分支平铺，V1/V2/V3 语义不变。
- 5e1fc2a: 记忆列表支持按关联用户筛选与展示，补全 listPresetSpeakers RPC 与客户端部分。

## 2026-08-28 version:0.16.0

- e1b15ef: 更新插件版本至 0.16.0。
- 39536fc: 重构 PGlite Vector Index 所有权生命周期，修复 HMR 交接与跨进程并发打开问题，移除锁文件和原生扩展依赖，并补充根工作区构建所需的类型兼容调整。
- 39536fc: 明确升级前需完整停止旧插件进程；确认停止后可手工删除旧 `vector-index.lock`，新版本不再创建该文件。
- fc9520f: 升级构建、类型检查、代码检查与格式化工具链，将测试运行器迁移至 Vitest，并统一 Worker 构建准备与测试文件并行执行。

## 2026-08-25 version:0.15.7

- b51f590: 优化召回快照日志，将多行召回内容改为独立区块显示。
