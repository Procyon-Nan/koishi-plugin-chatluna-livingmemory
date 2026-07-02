import type {
    AgenticMemorySearchToolCallSummary,
    AgenticMemorySnapshotMemoryItem
} from '../../types'
import { livingMemorySearchMemoryTypes } from '../../types'
import {
    broadSearchTextRule,
    formatSearchTextLengthRange,
    livingMemorySearchToolName,
    memorySearchMaxTextCount,
    specificSearchTextRule
} from '../memory/search_contract'

export interface AgenticRecallPlanPromptInput {
    presetLabel: string
    currentTranscript: string
    history: string
}

export interface AgenticRecallFinalPromptInput {
    presetLabel: string
    currentTranscript: string
    history: string
    toolCallSummary: AgenticMemorySearchToolCallSummary
    matchedMemories: AgenticMemorySnapshotMemoryItem[]
}

export const buildAgenticRecallPlanPrompt = (
    params: AgenticRecallPlanPromptInput
) => {
    const { presetLabel, currentTranscript, history } = params
    const memoryTypes = livingMemorySearchMemoryTypes.join('、')
    const broadRange = formatSearchTextLengthRange(broadSearchTextRule)
    const specificRange = formatSearchTextLengthRange(specificSearchTextRule)

    return [
        `你是${presetLabel}，对话历史中以“${presetLabel}说：...”开头的是你自己的发言。`,
        '你正在为下一轮回复提前召回可能需要的长期记忆。',
        '',
        '【任务目标】',
        `结合对话历史和最后一条信息，预测接下来最可能继续讨论的话题，并为 ${livingMemorySearchToolName} 工具选择查询参数。`,
        '',
        '【工具参数规则】',
        `- broadSearchTexts：1 到 ${memorySearchMaxTextCount} 个短查询词，每个查询词必须是 ${broadRange} 个字符。使用宽泛主题、对象、类别或一般需求。`,
        `- specificSearchTexts：可选但推荐，1 到 ${memorySearchMaxTextCount} 个长查询词，每个查询词必须是 ${specificRange} 个字符。使用更具体的事实、偏好、限制或关系描述。`,
        `- 如果没有合适的 ${specificRange} 个字符长查询词，就不要输出 specificSearchTexts 字段。`,
        `- 不要把 ${broadRange} 个字符的短查询词放进 specificSearchTexts。`,
        `- memoryTypes：只能使用 ${memoryTypes}。若需要全部类别，只输出 ["all"]。`,
        '- broadSearchTexts 和 specificSearchTexts 都是词面匹配查询词，不要写成长句。',
        '',
        '【输出格式】',
        '只输出一个 JSON 对象，不要输出 Markdown，不要解释。',
        'JSON 结构如下：',
        '{"broadSearchTexts":["午饭","喜欢吃"],"specificSearchTexts":["午饭比较喜欢吃"],"memoryTypes":["preference"]}',
        '',
        '【对话历史】',
        '"""',
        history,
        '"""',
        '',
        '【最后一条信息】',
        '"""',
        currentTranscript,
        '"""'
    ].join('\n')
}

export const buildAgenticRecallFinalPrompt = (
    params: AgenticRecallFinalPromptInput
) => {
    const {
        presetLabel,
        currentTranscript,
        history,
        toolCallSummary,
        matchedMemories
    } = params

    return [
        `你是${presetLabel}，正在为下一轮回复整理可注入的长期记忆文本。`,
        '',
        '【任务目标】',
        '根据对话历史、最后一条信息、工具查询参数和命中的记忆，生成一段纯文本记忆上下文，供回复模型使用。',
        '',
        '【任务要求】',
        '- 只写与接下来可能话题有关的记忆。',
        '- 保留具体事实、偏好、关系、计划和上下文。',
        '- 不要回答用户问题。',
        '- 不要解释工具调用过程。',
        '- 不要编造未命中的记忆。',
        '- 不要输出标题、编号、JSON 或 Markdown。',
        '',
        '【对话历史】',
        '"""',
        history,
        '"""',
        '',
        '【最后一条信息】',
        '"""',
        currentTranscript,
        '"""',
        '',
        '【工具查询参数】',
        JSON.stringify(toolCallSummary, null, 2),
        '',
        '【命中的记忆】',
        JSON.stringify(matchedMemories, null, 2),
        '',
        '【输出】'
    ].join('\n')
}
