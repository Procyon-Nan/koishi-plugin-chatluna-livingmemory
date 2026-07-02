import { livingMemorySearchMemoryTypes } from '../../types'
import {
    broadSearchTextRule,
    formatSearchTextLengthRange,
    livingMemorySearchToolName,
    memorySearchMaxTextCount,
    specificSearchTextRule
} from '../memory/search_contract'

export interface AgenticRecallPromptInput {
    presetLabel: string
    currentTranscript: string
    history: string
}

export const agenticRecallNoMemoryOutput = '<NO_MEMORY>'

export const buildAgenticRecallPrompt = (params: AgenticRecallPromptInput) => {
    const { presetLabel, currentTranscript, history } = params
    const memoryTypes = livingMemorySearchMemoryTypes.join('、')
    const broadRange = formatSearchTextLengthRange(broadSearchTextRule)
    const specificRange = formatSearchTextLengthRange(specificSearchTextRule)

    return [
        `你是${presetLabel}，对话历史中以“${presetLabel}说：...”开头的是你自己的发言。`,
        '',
        '【任务目标】',
        `1. 你要结合对话历史和最后一条信息，预测接下来最可能继续讨论的话题。`,
        `2. 调用 ${livingMemorySearchToolName} 查询可能与接下来的话题有关的记忆。`,
        '  - 如果调用工具的参数错误，你应该修正查询参数后再重新调用工具。',
        `3. 根据查询到的记忆，输出以你的视角叙述的纯文本记忆内容。`,
        '',
        '【工具参数规则】',
        `- broadSearchTexts：1 到 ${memorySearchMaxTextCount} 个短查询词，每个查询词必须是 ${broadRange} 个字符。使用宽泛主题、对象、类别或一般需求。`,
        `- specificSearchTexts：可选但推荐，1 到 ${memorySearchMaxTextCount} 个长查询词，每个查询词必须是 ${specificRange} 个字符。使用更具体的事实、偏好、限制或关系描述。`,
        `- 如果没有合适的 ${specificRange} 个字符长查询词，就不要输出 specificSearchTexts 字段。`,
        `- 不要把 ${broadRange} 个字符的短查询词放进 specificSearchTexts。`,
        `- memoryTypes：只能使用 ${memoryTypes}。若需要全部类别，只输出 ["all"]。`,
        '- broadSearchTexts 和 specificSearchTexts 都是词面匹配查询词，不要写成长句。',
        '',
        '【纯文本记忆内容格式要求】',
        '- 以第一人称视角叙述，保持你的角色风格和用语习惯。',
        '- 不要分段或分点。不要输出标题、编号、JSON 或 Markdown。',
        '- 只能以查询到的记忆为依据，不要编造未命中的记忆。',
        '- 保留记忆中的具体事实、偏好、关系、计划和上下文等内容。',
        '- 不要回答对话历史中的问题。不要回答最后一条信息的问题。不要解释工具调用过程。',
        `- 只关注与未来可能出现的话题有关的记忆。如果查询到的记忆都与未来可能出现的话题无关，只输出 ${agenticRecallNoMemoryOutput}。`,
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
