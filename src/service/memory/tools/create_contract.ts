import { z } from 'zod'
import { generatedMemorySchema } from '../../prompts/schema'

export const livingMemoryCreateMemoryToolName = 'living_memory_create_memory'

/**
 * 输入 schema 复用完整的模型记忆字段契约；speakerLabels 在执行时映射为
 * 当前 preset 下稳定的 speakerKeys；
 * 上限仅由 schema 硬校验，工具描述不携带数量指导。
 */
export const createLivingMemoryCreateInputSchema = (maxMemories: number) =>
    z.object({
        memories: z
            .array(generatedMemorySchema)
            .min(1)
            .max(maxMemories)
            .describe('本次要创建的记忆')
    })

export const livingMemoryCreateMemoryToolDescription = [
    '主动创建值得记录的长期记忆。',
    '',
    '当用户明确要求你记住某些信息或你认为在当前聊天中存在具有价值，需要记下来的内容时使用此工具。',
    '你需要依据当前聊天上下文决定需要创建的记忆内容。',
    '- memories：是必填项，每个元素按照工具参数说明填写一条完整记忆。',
    '- memories 是严格的 JSON 数组：正确 {"memories":[...]}；错误 {"memories":"[...]"}。',
    '- 记忆中的相对时间（如"今天"、"明天"、"上周"）必须结合对话上下文转换为具体日期；短期状态、身体状态、临时计划等可能在之后变化的内容，必须在 content 中写明具体日期。',
    '- 本工具返回创建结果 JSON：createdMemories 列出已写入记忆的 id 与类别；warnings 说明已保存但索引同步延迟等事项。'
].join('\n')
