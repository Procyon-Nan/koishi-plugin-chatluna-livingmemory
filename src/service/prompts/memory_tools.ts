import { z } from 'zod'
import { generatedMemorySchema } from './schema'

const memorySearchMaxTextCount = 3
const memorySearchMaxKeywordCount = 3
export const snapshotMaxLineLength = 100

const snapshotLineText = z
    .string()
    .regex(/^[^\r\n]+$/, '快照内容应为单行文本')
    .trim()
    .min(1)
    .max(snapshotMaxLineLength)
    .describe(`一条完整的记忆内容，使用单行文本，最多 ${snapshotMaxLineLength} 个字符。`)

export const memoryPassTool = {
    name: 'living_memory_pass',
    description: '记忆快照更新跳过工具，当你认为旧快照已经足够应付未来聊天话题，不需要更新时，使用此工具。',
    schema: z.object({})
}

export const memoryUpdateSnapshotTool = {
    name: 'living_memory_update_snapshot',
    description: [
        '记忆快照更新工具，当你认为旧快照需要补充、修改或删减，以适应未来聊天话题时使用此工具。',
        '你必须在一次工具调用中，完成所有对旧快照的按行编辑操作。'
    ].join('\n'),
    schema: z.object({
        operations: z
            .array(
                z.discriminatedUnion('type', [
                    z.object({
                        type: z.literal('append').describe('在末尾追加一行'),
                        text: snapshotLineText
                    }),
                    z.object({
                        type: z.literal('replace').describe('替换指定行的内容'),
                        line: z
                            .number()
                            .int()
                            .min(0)
                            .describe('旧快照中的行号，从 0 开始'),
                        text: snapshotLineText
                    }),
                    z.object({
                        type: z.literal('delete').describe('删除指定行'),
                        line: z
                            .number()
                            .int()
                            .min(0)
                            .describe('旧快照中的行号，从 0 开始')
                    })
                ])
            )
            .min(1)
            .describe(
                '所有按行编辑操作，每行最多可操作一次；追加内容按提交顺序排列。'
            )
    })
}

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
        '长期记忆的原始消息获取工具，当你需要获取某条记忆的原始消息时使用此工具；使用已知的记忆 ID 或调用 living_memory_search 工具检索得到记忆 ID。'
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
        '长期记忆更新工具，当你需要更新某条记忆时使用此工具；使用当前上下文已提供的记忆 ID。',
        '你应该在某条记忆中描述的内容过时、需要补充或是与你所知道的信息存在冲突时更新它。',
        '你应该提交更新后的完整记忆字段，不要遗漏或省略任一字段。'
    ].join('\n'),
    schema: z.object({
        memoryId: z.string().trim().min(1).describe('要更新的记忆 ID'),
        memory: generatedMemorySchema
    })
}

export const memoryMergeTool = {
    name: 'living_memory_merge_memories',
    description: [
        '长期记忆合并工具，当你需要将多条记忆合并成一条时使用此工具；使用当前上下文已提供的记忆 ID。',
        '你应该在多条记忆描述同一事件、关系、概念或偏好，且内容重复或互相补充时合并它们。',
        '你应该提交合并后的完整新记忆字段，不要遗漏或省略任一字段。'
    ].join('\n'),
    schema: z.object({
        sourceMemoryIds: z
            .array(z.string().trim().min(1))
            .min(2)
            .describe('要被合并的记忆 ID'),
        memory: generatedMemorySchema
    })
}

export const memorySplitTool = {
    name: 'living_memory_split_memory',
    description: [
        '长期记忆拆分工具，当你需要将一条记忆拆分为多条记忆时使用此工具；使用当前上下文已提供的记忆 ID。',
        '你应该在一条记忆包含了多个主题的事实内容时拆分它；拆分后的每条记忆主题唯一，且不丢失重要信息。',
        '你应该提交拆分后的完整新记忆字段，不要遗漏或省略任一字段。'
    ].join('\n'),
    schema: z.object({
        sourceMemoryId: z.string().trim().min(1).describe('要拆分的记忆 ID'),
        memories: z
            .array(generatedMemorySchema)
            .min(2)
            .describe('拆分后的新记忆')
    })
}

export const memoryDeleteTool = {
    name: 'living_memory_delete_memory',
    description: [
        '长期记忆删除工具，当你需要删除某条记忆时使用此工具；使用当前上下文已提供的记忆 ID。',
        '你应该在某条记忆与其他记忆内容重复、存在冲突或是过时时删除它；一般选择时间上更旧的记忆删除。'
    ].join('\n'),
    schema: z.object({
        memoryId: z.string().trim().min(1).describe('要删除的记忆 ID')
    })
}

export const memoryCheckedTool = {
    name: 'living_memory_checked_memory',
    description: [
        '长期记忆检查工具，当你确认记忆无需更新、合并或归档时使用此工具。'
    ].join('\n'),
    schema: z.object({
        memoryIds: z
            .array(z.string().trim().min(1))
            .min(1)
            .describe('已检查且无需变更的记忆 ID, 允许批量输入'),
        reason: z.string().trim().min(1).describe('记忆无需变更的理由')
    })
}

export const extractionResultTool = {
    name: 'living_memory_extraction_result',
    description:
        '记忆提取结果提交工具，当你需要提交从聊天记录中提取到的长期记忆时使用此工具。',
    schema: z.object({
        memories: z
            .array(generatedMemorySchema)
            .describe('本次提取的长期记忆；提取数量为零时提交空数组。'),
        reason: z
            .string()
            .trim()
            .min(1)
            .describe('提取这些记忆/不提取记忆的简短原因。')
    })
}

export const userProfileResultTool = {
    name: 'living_memory_user_profile_result',
    description:
        '人物画像更新工具，当你需要提交人物画像的更新或保留结果时使用此工具。',
    schema: z.object({
        action: z
            .enum(['update', 'keep'])
            .describe('update 表示生成或更新人物画像；keep 表示保留已有画像'),
        content: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
                '完整的新人物画像正文，长度不超过 300 个字符；action 为 update 时必须填写'
            ),
        reason: z.string().trim().min(1).describe('更新或保留人物画像的简短原因')
    })
}

export const personaCardResultTool = {
    name: 'living_memory_persona_card_result',
    description:
        '人设卡片删减工具，当你需要按行删减预设原文内容时使用此工具。',
    schema: z.object({
        deletedLineNumbers: z
            .array(z.number().int().min(0))
            .describe('要删除的行号列表，编号从 0 开始；保留全部内容时提交空数组。')
    })
}
