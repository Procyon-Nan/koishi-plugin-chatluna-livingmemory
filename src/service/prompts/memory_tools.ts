import { z } from 'zod'
import { generatedMemorySchema } from './schema'

const memorySearchMaxTextCount = 3
const memorySearchMaxKeywordCount = 3

export const memorySearchTool = {
    name: 'living_memory_search',
    description: [
        '长期记忆查询工具，当你需要在记忆库中查询记忆时使用此工具；检索相关度越高的记忆在工具结果中排名越靠前。'
    ].join('\n'),
    schema: z.object({
        searchTexts: z
            .array(z.string().trim().min(2).max(100))
            .min(1)
            .max(memorySearchMaxTextCount)
            .describe(
                '用于语义检索的短句，必须有完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等）；使用第一人称的自然语言描述；每个短句的语义主题唯一。'
            ),
        searchKeywords: z
            .array(z.string().trim().min(2).max(10))
            .max(memorySearchMaxKeywordCount)
            .optional()
            .describe(
                '用于准确匹配的关键词，必须是具体的事物、活动、地点等实体名称或专有名词；避免以用户名作为关键词进行查询。'
            )
    })
}

export const memoryGetMessagesTool = {
    name: 'living_memory_get_messages',
    description: [
        '长期记忆的原始消息获取工具，当你需要获取某条记忆的原始消息时使用此工具；使用此工具前，必须先使用 living_memory_search 工具得到目标记忆的 ID。'
    ].join('\n'),
    schema: z.object({
        memoryId: z.string().trim().min(1).describe('要获取原始消息的记忆 ID。')
    })
}

export const memoryCreateTool = {
    name: 'living_memory_create_memory',
    description: [
        '长期记忆创建工具，当你被明确要求记录信息，或你认为有值得长期记忆的内容时使用此工具。'
    ].join('\n'),
    schema: (maxMemories: number) =>
        z.object({
            memories: z
                .array(generatedMemorySchema)
                .min(1)
                .max(maxMemories)
                .describe('要创建的记忆对象，内容根据当前上下文决定。')
        })
}

export const memoryUpdateTool = {
    name: 'living_memory_update_memory',
    description: [
        '长期记忆更新工具，当你需要更新某条记忆时使用此工具；使用此工具前，必须先使用 living_memory_search 工具得到目标记忆的 ID。',
        '你应该在某条记忆中描述的内容过时、需要补充或是与你所知道的信息存在冲突时更新它。',
        '你应该提交更新后的完整记忆字段，不要遗漏或省略任一字段。'
    ].join('\n'),
    schema: z.object({
        memoryId: z.string().trim().min(1).describe('要更新的记忆 ID'),
        memory: generatedMemorySchema
    })
}

export const memoryDeleteTool = {
    name: 'living_memory_delete_memory',
    description: [
        '长期记忆删除工具，当你需要删除某条记忆时使用此工具；使用此工具前，必须先使用 living_memory_search 工具得到目标记忆的 ID。',
        '你应该在某条记忆与其他记忆内容重复、存在冲突或是过时时删除它；一般选择时间上更旧的记忆删除。'
    ].join('\n'),
    schema: z.object({
        memoryId: z.string().trim().min(1).describe('要删除的记忆 ID')
    })
}
