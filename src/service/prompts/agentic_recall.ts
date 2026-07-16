import { livingMemorySearchToolName } from '../memory/tools/search_contract'
import {
    formatPresetPerspectiveRule,
    TRANSCRIPT_SPEAKER_RULE,
    TRANSCRIPT_TIMESTAMP_RULE
} from './transcript_contract'

export interface AgenticRecallPromptInput {
    presetLabel: string
    currentTranscript: string
    history: string
}

export const agenticRecallNoMemoryOutput = '<NO_MEMORY>'

export const buildAgenticRecallFinalizationPrompt = () => {
    return [
        '工具调用阶段已经结束，不得再调用或请求任何工具。',
        '请仅根据前面已经返回的记忆搜索结果，立即输出最终纯文本记忆内容。',
        `如果没有可靠且相关的记忆，只输出 ${agenticRecallNoMemoryOutput}。`,
        '不要解释工具调用过程，不要输出标题、编号、JSON 或 Markdown。'
    ].join('\n')
}

export const buildAgenticRecallPrompt = (params: AgenticRecallPromptInput) => {
    const { presetLabel, currentTranscript, history } = params

    return [
        formatPresetPerspectiveRule(presetLabel),
        TRANSCRIPT_SPEAKER_RULE,
        TRANSCRIPT_TIMESTAMP_RULE,
        '',
        '【任务目标】',
        `1. 你要结合对话历史和最后一条信息，预测接下来最可能继续讨论的话题。`,
        `2. 调用 ${livingMemorySearchToolName} 查询可能与接下来的话题有关的记忆。`,
        `  - 你可以调用且**只可以**调用 ${livingMemorySearchToolName} 工具来查询记忆，不可以调用其他工具。`,
        '  - broadSearchTexts、specificSearchTexts 和 memoryTypes 必须直接传递 JSON 数组，禁止把数组编码成字符串。',
        '  - 如果调用工具的参数错误，你应该修正查询参数后再重新调用工具。',
        `3. 根据查询到的记忆，输出以你的视角叙述的纯文本记忆内容。`,
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
