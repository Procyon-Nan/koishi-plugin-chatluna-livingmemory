# 模型记忆视图统一整改方案

日期：2026-10-19。状态：自检后已按用户授权实施，验证结果见第 8 节。

## 1. 目标与范围

在 `src/service/prompts/memory_entries.ts` 中集中定义记忆字段的文本格式，各调用方通过固定字段清单选择内容和顺序，统一经 `renderMemoriesForModel()` 渲染。

本次解决三个问题：

- Dream 的字段由 `formatMemoryEntryForPrompt()` 与 `buildDreamBatchPrompt()` 分别拼装，speaker 标签在外部补写。
- Dream 与搜索、画像重复定义 ID、类型、日期、情绪和正文的输出格式。
- 同一个可空字段存在两种显示规则：Dream 输出空赋值行，搜索和画像省略该行。

保留实际需要的视图差异，不扩大任何工作流的输入字段，不改变记忆存储、生成 schema、检索逻辑、工具暴露面、批次划分或压缩规则。不新增文件层级、类、服务、可变注册表、模板语言或缓存。

## 2. sentiment 空值的事实核查

`sentiment` 表示简短的情绪标注。整改前核查情况如下：

| 层次 | 当前约束 |
| --- | --- |
| `prompts/schema.ts` 的 `generatedMemorySchema` | 使用 `z.string().trim().min(1)`，要求非空；没有明显情绪时可写“平静” |
| 当前 WebUI 记忆编辑器 | 保存前要求情绪字段非空 |
| `contracts/memory.ts` 的 `MemoryMutationInput` | `sentiment?: string \| null`，通用写入接口允许省略或为空 |
| `persistence/tables.ts` | 情绪列允许 `null`，默认 `null` |
| `memory/entry_fields.ts` 与持久化 normalizer | 空串及空白文本归一为 `null` |
| 整改前 Dream 渲染 | `${entry.sentiment ?? ''}`：值为 `null` 时输出 `sentiment=` |
| 整改前搜索、画像渲染 | 值为 `null` 时省略情绪行 |

2026-10-19 对本地原始 SQLite 数据进行只读聚合检查：“所长（Character）”预设的 135 条活跃记忆、90 条归档记忆中，`sentiment IS NULL` 和空白情绪字段均为 0。这是该预设在检查时点的结果，不代表所有数据来源均不能产生空值。

因此，“Dream 会输出空 sentiment”指代码在数据缺失时的表现，不是本次真实 Dream 已观察到空情绪，也不是要求模型把情绪留空。通用写入允许缺失字段，渲染层需要准确表示已有数据；不将缺失值自动补成“平静”，因为未记录情绪与明确标注平静含义不同。

本方案仅统一显示规则：可空字段为 `null` 时省略整行。若后续要求所有存量记忆的情绪必须非空，应单独调整写入契约、数据库与迁移策略，不混入本次渲染整改。

## 3. 单一字段格式定义

在 `memory_entries.ts` 中用一个模块私有的字段格式函数集中处理以下规则。只计算本次选中的字段，避免精简视图无意义地解析 speaker。采用普通函数和明确分支即可，不引入字段处理器注册机制。

| 字段键 | 输出格式 | 空值规则 |
| --- | --- | --- |
| `id` | `id=<原 ID>` | 输入必需 |
| `type` | `type=<类型>` | 输入必需 |
| `createdAt` | `createdAt=<ISO 时间>` | 输入必需 |
| `updatedAt` | `updatedAt=<ISO 时间>` | 输入必需 |
| `sentiment` | `sentiment=<情绪标注>` | `null` 时省略，不补“平静” |
| `importance` | `importance=<数值>` | `null` 时省略；0 必须保留 |
| `keywords` | `keywords=<以顿号连接的关键词>` | 空数组保留 `keywords=` |
| `summary` | `summary=<摘要>` | `null` 时省略 |
| `sourceLabel` | `source=<来源标签>` | `null` 时省略 |
| `content` | `content:` 换行后接原正文 | 输入必需，不裁剪或改写 |
| `speakerLabels` | `speakerLabels=<JSON 字符串数组>` | 明确无关联用户时保留 `[]`；缺少解析数据不得冒充空数组 |

字段格式函数返回字符串或 `null`；上层只过滤 `null`，不使用可能误丢有效值的真值过滤。沿用持久化已建立的字段类型和空值归一规则，不在渲染层重复清洗数据或猜测日期格式。

所有字段返回未进行 XML 转义的文本。XML 包装仍由调用方通过 `formatXmlBlock()` 执行一次；工具文本结果保持既有输出方式，避免重复转义或改变工具结果协议。

## 4. 字段清单与调用接口

同一模块维护三份只读字段清单，清单只定义字段名与顺序，不含格式化回调：

| 清单 | 使用位置 | 字段顺序 |
| --- | --- | --- |
| `dreamMemoryFields` | Dream 完整批次 | `id, type, createdAt, updatedAt, sentiment, importance, keywords, summary, content, speakerLabels` |
| `searchMemoryFields` | 主对话与 Dream 的检索工具 | `id, type, updatedAt, sentiment, sourceLabel, content` |
| `contextMemoryFields` | Agentic Recall 检索结果及用户画像 | `type, updatedAt, sentiment, sourceLabel, content` |

不把 Dream 当前未展示的 `sourceLabel` 额外加入批次。保留现有字段顺序，包括正文后的 speaker 标签；本次只集中格式规则与统一 null 行处理。

统一调用形状：

```ts
renderMemoriesForModel(cluster.entries, {
    fields: dreamMemoryFields,
    speakers
})

renderMemoriesForModel(results, {
    fields: includeMemoryIds ? searchMemoryFields : contextMemoryFields
})

renderMemoriesForModel(group.entries, {
    fields: contextMemoryFields
})
```

输入类型与 speaker 约束：

- 将现有 `ModelMemoryView` 改为从 `MemoryEntryRecord` 取上述十个基础字段的 `Pick`，不复制一套字段类型，也不直接依赖命名为搜索结果的契约。当前 `LivingMemorySearchResult` 和 `DreamMemoryEntryRecord` 均具备这些字段。
- `MemoryModelField` 由有限的基础字段键与派生的 `speakerLabels` 组成，不接受任意字符串。
- 使用两个简单函数重载表达真实输入差异：基础视图仅接受不含 `speakerLabels` 的字段清单；包含该字段的调用要求记录具备 `speakerKeys`，并提供 `speakers`。两个重载共用一个实现，不新增第二个渲染入口，不引入递归条件类型或通用投影类型系统。
- Dream 的 speaker 列表继续来自 `ensurePresetSpeakersCoverage()`。渲染函数在需要时为当前调用建立一次 `speakerKey → speaker record` Map，按记忆中 `speakerKeys` 的原有顺序取昵称。
- 不查数据库，不跨调用缓存 Map，不返回身份键代替昵称，不静默过滤找不到的关联。沿用上游注册表覆盖约束，缺失关联不得被序列化为 `null` 或空数组。
- 搜索接口不具有 `speakerKeys`，保持其现有数据契约；本方案不为了统一渲染而扩展搜索返回或补查 speaker。

`renderMemoriesForModel()` 按字段清单顺序生成每条记忆，字段间使用换行，记忆间统一使用 `\n\n---\n\n`。删除现有 `includeId` 渲染选项，由字段清单表达同一语义；检索工具自身的 `includeMemoryIds` 暴露面选项继续保留。

## 5. 具体文件改动

| 文件 | 改动 |
| --- | --- |
| `src/service/prompts/memory_entries.ts` | 集中字段格式与清单；调整 `ModelMemoryView`；实现带字段选择的统一渲染；删除 `formatMemoryEntryForPrompt()` |
| `src/service/prompts/dream.ts` | 调用统一渲染器取得整批文本，再包裹 `memory_entries` 与 `dream_input`；删除逐条 speaker 查找、字段补拼与条目分隔 |
| `src/service/memory/tools/embedding_search_tool.ts` | 将现有 ID 显示开关映射到搜索或上下文字段清单，其余检索和格式行为保持不变 |
| `src/service/prompts/user_profile.ts` | 使用上下文字段清单，继续不显示记忆 ID |
| `tests/prompt-contracts.spec.ts` | 调整既有完整字段与转义断言，覆盖统一 null 行规则及 speaker 空数组语义 |
| `tests/memory-tools.spec.ts` | 复用既有搜索结果断言，验证字段集合与 ID 暴露面不变 |
| `tests/dream-session.spec.ts` | 复用既有完整批次、压缩保留与前缀检查，避免新增只测试搬移行为的用例 |
| `AGENTS.md` | 明确字段格式与字段清单统一位于 `memory_entries.ts`，模型记忆视图统一经 `renderMemoriesForModel()`；保留按需显示 ID 的规则 |
| `docs/dream-session-plan.md` | 同步统一字段渲染职责，记录缺失可选字段省略行的显示语义 |
| `CHANGELOG.md` | 按当前版本记录本次接口与显示规则调整，未提交使用 pending |

`renderMemorySourceMessagesForModel()` 渲染的是来源消息及其来源关系，不属于记忆条目字段投影，保持现有实现。通用写入、导入、数据库 schema 和模型生成字段约束均不修改。

## 6. 实施顺序

1. 在同一次源码变更中实现统一字段格式、字段清单与渲染接口，完成三个调用位置的替换，并删除旧单条渲染函数。不保留临时兼容签名。
2. 调整既有测试与规范文档，检查所有旧函数、`includeId` 渲染选项及外部 speaker 拼接引用均已清除。
3. 运行规定检查并复核字段选择、空值、speaker 解析、顺序和转义。通过后交由用户审查并手动提交；无需真实模型请求。

## 7. 验收标准

- 对各字段均非空的输入，Dream、搜索、Recall 和画像的渲染结果与现有输出逐字一致，包括顺序、日期、JSON、换行和分隔符。
- nullable 的 `sentiment`、`summary`、`importance`、`sourceLabel` 为 null 时省略整行；保留 `importance=0`、空关键词和明确的空关联数组。
- Dream 多关联用户按输入 key 顺序显示当前标签；搜索和画像不增加 speaker 查询或额外身份字段。
- Dream 完整批次仍含原有全部非空字段；主对话和 Dream 检索保留 ID，Recall 检索和画像继续隐藏 ID；正文中的 XML 特殊字符仍只转义一次。
- 压缩后的当前批次、工具配对和普通轮次的追加式前缀保持现有行为。
- 不更改 `sentiment` 的生成必填约束，不自动为缺失情绪赋值，也不改写任何存量记忆。

检查命令：`yarn lint`、`yarn test`、`yarn atsc -p tsconfig.json --noEmit`、`git diff --check`。本次仅服务端渲染与既有测试调整，无需客户端构建或真实供应商请求；如果实际实现触及包边界，再按项目规则补充服务端构建。

## 8. 自检与实施记录

方案自检确认现有输入契约已具备所需字段，三个生产调用位置可一次完成替换，无需数据迁移、额外 speaker 查询或兼容入口，没有待决策事项。

已完成字段清单、统一渲染与调用方替换，删除旧单条格式函数及 `includeId` 渲染选项；同步开发规范、Dream 说明与变更日志。字段清单使用只读元组，speaker 映射仅在选中该字段时建立，搜索与上下文视图共享同一基础字段顺序。

既有提示词测试改为核对完整 Dream 文本，补充 null、0、空数组及 speaker 顺序和转义断言；既有搜索用例同时核对显示与隐藏 ID 的完整输出。Dream 会话测试无需修改，继续验证完整当前批次保留及压缩行为。

验证结果：`yarn lint`、`yarn atsc -p tsconfig.json --noEmit`、`yarn test`（45 个测试文件、368 项测试）和 `git diff --check` 均通过。未运行真实供应商请求，未修改数据或 ChatLuna，未执行 Git 提交。
