import { z } from 'zod'
import { generatedMemorySchema } from './schema'

const memorySearchMaxTextCount = 3
const memorySearchMaxKeywordCount = 3

export const memorySearchTool = {
    name: 'living_memory_search',
    description: [
        '在当前预设的活跃记忆中搜索记忆，不检索归档记忆。',
        '',
        '当你需要查找自己的记忆时使用此工具。',
        `- searchTexts：必填 JSON 数组，包含 1 到 ${memorySearchMaxTextCount} 条语义查询短语，` +
            '每条在去除首尾空白后须为 2 到 100 个字符。' +
            '必须包含完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等），' +
            '使用第一人称的自然语言描述。不同短语应覆盖不同的语义角度。',
        `- searchKeywords：选填 JSON 数组，最多 ${memorySearchMaxKeywordCount} 个精确关键词，` +
            '每个在去除首尾空白后须为 2 到 10 个字符。' +
            '关键词应为具体的事物、活动、地点等实体名称，不应是完整句子。' +
            '禁止使用用户昵称、用户名或称呼作为关键词，这类词匹配无意义。',
        '- 直接传递数组，禁止把数组编码成 JSON 字符串。',
        '- 本工具返回的记忆条目依照计算后的相关度得分排序。'
    ].join('\n'),
    schema: z.object({
        searchTexts: z
            .array(z.string().trim().min(2).max(100))
            .min(1)
            .max(memorySearchMaxTextCount)
            .describe(
                `用于语义检索的第一人称查询短语。提供 1 到 ${memorySearchMaxTextCount} 条短语，` +
                    '每条在去除首尾空白后为 2 到 100 个字符。' +
                    '必须包含完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等），' +
                    '使用第一人称的自然语言描述。不同的查询短语应覆盖不同的语义角度。'
            ),
        searchKeywords: z
            .array(z.string().trim().min(2).max(10))
            .max(memorySearchMaxKeywordCount)
            .optional()
            .describe(
                `用于关键词匹配的精确关键词。提供 0 到 ${memorySearchMaxKeywordCount} 个关键词，` +
                    '每个在去除首尾空白后为 2 到 10 个字符。' +
                    '关键词应为具体的事物、活动、地点等实体名称，不应是完整句子。' +
                    '禁止使用用户昵称、用户名或称呼作为关键词，这类词匹配无意义。'
            )
    })
}

export const memoryGetMessagesTool = {
    name: 'living_memory_get_messages',
    description: [
        '查看单条记忆的来源对话消息。',
        '',
        '当你需要确认某条记忆的原始对话依据时使用此工具。',
        '- memoryId：必填字符串，来自 living_memory_search 结果的记忆 ID。',
        '- 每次只查看一条记忆；结果按原始聊天记录格式渲染其全部来源对话，多段来源分组编号。',
        '- 没有记录来源消息的记忆会明确说明。',
        '- 本工具仅读取当前预设拥有的记忆。'
    ].join('\n'),
    schema: z.object({
        memoryId: z
            .string()
            .trim()
            .min(1)
            .describe(
                '要查看来源对话的记忆 ID。使用 living_memory_search 结果中返回的 ID。'
            )
    })
}

export const memoryCreateTool = {
    name: 'living_memory_create_memory',
    description: [
        '主动创建值得记录的长期记忆。',
        '',
        '当用户明确要求你记住某些信息或你认为在当前聊天中存在具有价值，需要记下来的内容时使用此工具。',
        '你需要依据当前聊天上下文决定需要创建的记忆内容。',
        '- memories：是必填项，每个元素按照工具参数说明填写一条完整记忆。',
        '- memories 是严格的 JSON 数组：正确 {"memories":[...]}；错误 {"memories":"[...]"}。',
        '- 记忆中的相对时间（如"今天"、"明天"、"上周"）必须结合对话上下文转换为具体日期；短期状态、身体状态、临时计划等可能在之后变化的内容，必须在 content 中写明具体日期。',
        '- 本工具返回创建结果 JSON：createdMemories 列出已写入记忆的 id 与类别；warnings 说明已保存但索引同步延迟等事项。'
    ].join('\n'),
    schema: (maxMemories: number) =>
        z.object({
            memories: z
                .array(generatedMemorySchema)
                .min(1)
                .max(maxMemories)
                .describe('本次要创建的记忆')
        })
}

export const memoryUpdateTool = {
    name: 'living_memory_update_memory',
    description: [
        '更新当前预设中已有的活跃记忆。',
        '当记忆内容有误、发生变化或需要补充时使用，先通过记忆检索取得目标 ID。',
        '提交完整记忆字段，覆盖原内容和关联用户；speakerLabels 为空数组时清空关联用户。来源对话保持不变。',
        '相对时间必须结合对话上下文转换为具体日期；会变化的状态与计划必须在正文中注明日期。',
        '只能更新当前预设的活跃记忆，不能恢复归档记忆。',
        '返回 JSON：memoryId 为目标 ID，updated 表示是否完成更新，warnings 说明已保存但索引同步延迟等事项。'
    ].join('\n'),
    schema: z.object({
        memoryId: z
            .string()
            .trim()
            .min(1)
            .describe('要更新的活跃记忆 ID，来自记忆检索结果。'),
        memory: generatedMemorySchema
    })
}

export const memoryDeleteTool = {
    name: 'living_memory_delete_memory',
    description: [
        '删除当前预设中不再需要的活跃记忆。',
        '先通过记忆检索确认目标 ID。删除实际执行归档，将记忆从活跃检索中移除，保留记忆正文与来源消息。',
        '每次处理一条记忆；目标不存在、已归档或不属于当前预设时不产生变更。',
        '返回 JSON：memoryId 为目标 ID，deleted 表示本次是否完成归档，warnings 说明已保存但索引同步延迟等事项。'
    ].join('\n'),
    schema: z.object({
        memoryId: z
            .string()
            .trim()
            .min(1)
            .describe('要删除（归档）的活跃记忆 ID，来自记忆检索结果。')
    })
}
