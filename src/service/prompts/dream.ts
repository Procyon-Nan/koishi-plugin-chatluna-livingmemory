import type { DreamCluster, DreamStage } from '../dream/types'
import { toPromptEntry } from '../dream/util'
import { MEMORY_KEYWORDS_DESCRIPTION } from './extraction'
import { DREAM_ACTIVE_FORMAT, DREAM_ARCHIVED_FORMAT } from './schema'

/**
 * 构建 Dream 整理提示词。纯函数，按阶段（active / archived）切换操作指南与输出格式。
 * 输出格式串引用自 ./schema，与 dream/parser.ts 保持单一真相源。
 */
export const buildDreamPrompt = (
    presetId: string,
    cluster: DreamCluster,
    stage: DreamStage
) => {
    const activeOperationGuide = [
        '可执行操作：',
        '- keep：记忆彼此不重复，保持不变。',
        '- update：某条 active 记忆需要补充信息增量，保持同一条记忆的基本身份。',
        '- merge：多条 active 记忆描述同一对象、同一状态或同一关系画像时，选择一条作为 target，写成更完整的新正文；其余 source 会被代码层自动改为 archived 历史记录。',
        '- archive：某条 active 记忆已经过时或与新状态冲突，只把它标记为 archived。',
        '- active 阶段禁止物理删除记忆。'
    ]
    const archivedOperationGuide = [
        '可执行操作：',
        '- keep：历史记录彼此不重复，保持不变。',
        '- update：某条 archived 历史记录需要补充归档语义，仍然保持 archived。',
        '- merge：多条 archived 历史记录描述同一历史阶段、同一对象或同一关系变化时，选择一条作为 target，压缩成更完整的 archived 历史档案；其余 source 会被代码层物理删除。',
        '- deleteSource：只用于声明 merge 的 source 可以删除；代码层只会删除成功 merge 的 source，独立 deleteSource 会被跳过。',
        '- archived 阶段禁止恢复为 active，也禁止使用 archive 操作。'
    ]
    const operationFieldGuide = [
        '操作字段要求：',
        '- keep：输出 action、memoryIds、reason，不要输出 memory。',
        '- update：必须指定 memoryId 和 memory；memory 必须完整输出重新生成后的 type、content、summary、keywords、sentiment、importance。',
        '- merge：必须指定 targetMemoryId、sourceMemoryIds 和 memory；memory 必须完整输出合并后重新生成的 type、content、summary、keywords、sentiment、importance。',
        '- archive：必须指定 memoryId；不要输出 memory，代码层只会把该条记忆的 status 改为 archived。',
        stage === 'archived'
            ? '- deleteSource：只能声明已成功 merge 的 source 可以物理删除，不要单独用于删除。'
            : '- active 阶段不要输出 deleteSource。',
        '- 无法为 update / merge 完整重新生成 type、content、summary、keywords、sentiment、importance 时，改用 keep，不要输出缺字段的 update / merge。'
    ]
    const activeFormat = DREAM_ACTIVE_FORMAT
    const archivedFormat = DREAM_ARCHIVED_FORMAT

    return [
        '你是长期记忆 Dream 档案员。',
        '你的任务是整理同一 preset 下已有的记忆条目，而不是重新创作新记忆。',
        '你只能基于下面给出的记忆条目做判断，禁止引入条目之外的新事实。',
        stage === 'active'
            ? '当前阶段只处理 active 记忆：目标是软整理当前可召回记忆，保留关系演化痕迹。'
            : '当前阶段只处理 archived 历史记录：目标是真正压缩历史档案，减少重复归档。',
        '',
        `presetId=${presetId}`,
        `stage=${stage}`,
        `clusterId=${cluster.id}`,
        `clusterReason=${cluster.reason}`,
        '',
        ...(stage === 'active' ? activeOperationGuide : archivedOperationGuide),
        '',
        '合并判断依据：',
        '1. 事实一致性：同一对象同一状态的信息应合并。',
        '2. 信息增量：新记忆提供旧记忆没有的维度时，应补充而不是丢弃。',
        '3. 时间权重与冲突：出现矛盾时以较新的状态为有效值，旧状态应标记为 archived。',
        '4. importance 越高越应保留为 target 或被认真整合；sentiment 用于判断情绪和关系阶段。',
        '',
        ...operationFieldGuide,
        '',
        '输出必须是可解析 JSON，不要解释，不要 Markdown。',
        '格式：',
        stage === 'active' ? activeFormat : archivedFormat,
        '',
        '字段要求：',
        '- content 是最终会注入给 preset 的记忆正文，应保持第一人称关系视角。字数保持在100字以内。',
        '- summary 是检索友好的简短摘要，不要写成角色台词。',
        `- keywords：${MEMORY_KEYWORDS_DESCRIPTION}；最多 12 个。`,
        '- update / merge 必须同步重新生成 memory.type、content、summary、keywords、sentiment、importance。',
        '- update / merge 的 keywords 必须基于最终 memory.content 重新提取，不能复用、拼接或合并旧记忆的 keywords，也不要把正文按标点切成整句片段。',
        '- 不要在 content、summary 或 keywords 中写入“历史记录”、“已合并”等状态或整理标记；归档状态由 status 字段表达。',
        '- sentiment 是简短自由文本。',
        '- importance 必须是 0 到 1 的数字。',
        '- 所有 memoryId、targetMemoryId、sourceMemoryIds 必须来自下面的 id。',
        stage === 'archived'
            ? '- archived 阶段输出的 memory 不能包含 active 状态；即使包含也会被代码层强制保持 archived。'
            : '- active 阶段的 update / merge target 会被代码层强制保持 active。',
        '',
        '记忆条目：',
        cluster.entries.map(toPromptEntry).join('\n\n---\n\n')
    ].join('\n')
}
