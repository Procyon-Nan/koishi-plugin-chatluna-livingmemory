import { z } from 'zod'
import { extractedMemorySchema } from '../../prompts/schema'
import {
    MEMORY_COMPLETE_FIELD_LIST,
    MEMORY_CONTENT_REQUIREMENT,
    MEMORY_IMPORTANCE_REQUIREMENT,
    MEMORY_KEYWORDS_REQUIREMENT,
    MEMORY_SENTIMENT_REQUIREMENT,
    MEMORY_SPEAKER_REFERENCE_REQUIREMENT,
    MEMORY_SUMMARY_REQUIREMENT,
    MEMORY_TYPE_GUIDE
} from '../../prompts/memory_fields'

export const livingMemoryCreateMemoryToolName = 'living_memory_create_memory'

/**
 * 输入 schema 逐字复用 extractedMemorySchema（提取输出的单一真相源），
 * 保证被动提取与主动创建产出的记忆字段完全同构；
 * 上限仅由 schema 硬校验，工具描述不携带数量指导。
 */
export const createLivingMemoryCreateInputSchema = (maxMemories: number) =>
    z.object({
        memories: z
            .array(extractedMemorySchema)
            .min(1)
            .max(maxMemories)
            .describe(
                `本次要创建的长期记忆。每条完整包含 ${MEMORY_COMPLETE_FIELD_LIST} 六个字段。`
            )
    })

export const livingMemoryCreateMemoryToolDescription = [
    '主动将当前对话中的内容写入你的长期记忆。',
    '',
    '在以下情形使用此工具：用户明确要求你记住某些信息；或出现显著重要、等待自动提取可能丢失的信息。',
    '是否调用以及记录什么内容，由你依据当前对话上下文自主判断。',
    `- memories：必填 JSON 数组，每个元素是一条完整记忆，包含 ${MEMORY_COMPLETE_FIELD_LIST} 六个字段。`,
    '- memories 必须直接传 JSON 数组：正确 {"memories":[...]}；错误 {"memories":"[...]"}。',
    '每条记忆遵循以下字段规范：',
    MEMORY_TYPE_GUIDE,
    MEMORY_CONTENT_REQUIREMENT,
    MEMORY_SUMMARY_REQUIREMENT,
    MEMORY_KEYWORDS_REQUIREMENT,
    MEMORY_SENTIMENT_REQUIREMENT,
    MEMORY_IMPORTANCE_REQUIREMENT,
    MEMORY_SPEAKER_REFERENCE_REQUIREMENT,
    '- 记忆中的相对时间（如"今天"、"明天"、"上周"）必须结合对话上下文转换为具体日期；短期状态、身体状态、临时计划等可能在之后变化的内容，必须在 content 中写明具体日期。',
    '- 本工具返回创建结果 JSON：createdMemories 列出已写入记忆的 id 与类别；warnings 说明已保存但索引同步延迟等事项。',
    '- 写入的记忆会进入检索库，供你之后的记忆搜索与召回使用。'
].join('\n')
