export interface RecallRewritePromptInput {
    /** 角色名标签。 */
    presetLabel: string
    /** 当前发言者最后一条信息（为空时回退到 cleanedQuery）。 */
    currentTranscript: string
    /** cleanedQuery，currentTranscript 为空时的回退值。 */
    cleanedQuery: string
    /** 已格式化的近期对话历史，无历史时为 '无'。 */
    history: string
}

/**
 * 构建召回查询改写提示词。纯函数：presetLabel / history 等均由调用方预先算好传入。
 */
export const buildRecallRewritePrompt = (
    params: RecallRewritePromptInput
): string => {
    const { presetLabel, currentTranscript, cleanedQuery, history } = params
    return [
        `你是${presetLabel}，对话历史中以“${presetLabel}说：...”开头的是你自己的发言。`,
        '【任务目标】',
        '你要结合对话历史和最后一条信息，总结你们当前的话题内容。',
        '',
        '【任务要求】',
        `使用第一人称口吻来叙述，保留你自己的说话语气和风格。`,
        '使用对话中每一条发言的前缀指代具体发言者，不要泛称“用户”。',
        '保留对关系、情绪、互动状态、重要事实的具体叙述。',
        '不要写成主题标签、分类词或关键词列表。',
        '不要输出“偏好、关系、互动状态”这类抽象概括。',
        '去掉寒暄、口癖、用户名前缀和无关噪声。',
        '不要进行问题回答，不要进行解释说明。',
        '只输出一行当前话题的内容。字数不超过50字，保证简洁、清晰。',
        '',
        '正确输出示例：',
        '张三说我的研究所是虚构的。李四说他肚子疼。王五让我正确使用工具',
        '张三夸我可爱，我觉得心情很不错',
        '我把张三骂了一顿',
        '',
        '错误输出示例：',
        '张三的偏好、与某人的关系及近期互动状态',
        `张三夸${presetLabel}可爱，${presetLabel}觉得心情很不错。`,
        `${presetLabel}说：我把张三骂了一顿。`,
        '',
        '【对话历史】',
        '"""',
        history,
        '"""',
        '',
        '【最后一条信息】',
        '"""',
        currentTranscript.length > 0 ? currentTranscript : cleanedQuery,
        '"""',
        ''
    ].join('\n')
}
