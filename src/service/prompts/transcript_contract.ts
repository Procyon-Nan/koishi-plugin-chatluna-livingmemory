export const formatPresetPerspectiveRule = (presetLabel: string) => {
    return `你是${presetLabel}，对话历史中以“${presetLabel}说：...”开头的是你自己的发言。`
}

export const TRANSCRIPT_TIMESTAMP_RULE =
    '- 每条消息前的方括号中是该消息的实际发送时间，不属于发言内容；应据此理解消息的先后关系和时间间隔。'

export const TRANSCRIPT_SPEAKER_RULE =
    '- 以“昵称说：”开头的是具体发言者的发言；不同昵称代表不同发言者，不要用“用户”、“对方”等泛称替代。'
