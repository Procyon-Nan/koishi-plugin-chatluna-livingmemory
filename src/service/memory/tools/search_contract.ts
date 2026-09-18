import { z } from 'zod'
import type { LivingMemorySearchInput } from '../../../contracts/memory'

export const livingMemorySearchToolName = 'living_memory_search'
export const livingMemoryGetMessagesToolName = 'living_memory_get_messages'

export const memorySearchMaxTextCount = 3
export const memorySearchMaxKeywordCount = 3

interface SearchFieldRule {
    fieldName: string
    minLength: number
    maxLength: number
}

export const searchTextRule: SearchFieldRule = {
    fieldName: 'searchTexts',
    minLength: 2,
    maxLength: 100
}

export const searchKeywordRule: SearchFieldRule = {
    fieldName: 'searchKeywords',
    minLength: 2,
    maxLength: 10
}

export const normalizeSearchText = (value: string) => {
    return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

export const countSearchTextCharacters = (value: string) => {
    return Array.from(normalizeSearchText(value)).length
}

export const formatSearchTextLengthRange = (rule: SearchFieldRule) => {
    return `${rule.minLength} 到 ${rule.maxLength}`
}

export const formatSearchTextLengthError = (rule: SearchFieldRule) => {
    return `${rule.fieldName} 的每个条目在去除首尾空白后必须是 ${formatSearchTextLengthRange(rule)} 个字符。`
}

const createSearchFieldSchema = (rule: SearchFieldRule) =>
    z
        .string()
        .refine(
            (value) => {
                const length = countSearchTextCharacters(value)
                return length >= rule.minLength && length <= rule.maxLength
            },
            {
                message: formatSearchTextLengthError(rule)
            }
        )
        // ChatLuna AgentRunner 的入参修复会把「字段级字符串」包成单元素数组，
        // 该校验是唯一阻止字符串化数组被静默修复执行的边界。
        .refine((value) => !/^\s*\[.*\]\s*$/u.test(value), {
            message: `${rule.fieldName} 必须直接传递数组。`
        })

const searchTextDescription =
    `用于语义检索的第一人称查询短语。提供 1 到 ${memorySearchMaxTextCount} 条短语，` +
    `每条在去除首尾空白后为 ${formatSearchTextLengthRange(searchTextRule)} 个字符。` +
    '必须包含完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等），' +
    '使用第一人称的自然语言描述。不同的查询短语应覆盖不同的语义角度。'

const searchKeywordDescription =
    `用于关键词匹配的精确关键词。提供 0 到 ${memorySearchMaxKeywordCount} 个关键词，` +
    `每个在去除首尾空白后为 ${formatSearchTextLengthRange(searchKeywordRule)} 个字符。` +
    '关键词应为具体的事物、活动、地点等实体名称，不应是完整句子。' +
    '禁止使用用户昵称、用户名或称呼作为关键词，这类词匹配无意义。'

export type LivingMemorySearchToolInput = Pick<
    LivingMemorySearchInput,
    'searchTexts' | 'searchKeywords' | 'memoryStatus'
>

export const livingMemorySearchInputSchema = z.object({
    searchTexts: z
        .array(createSearchFieldSchema(searchTextRule))
        .min(1)
        .max(memorySearchMaxTextCount)
        .describe(searchTextDescription),
    searchKeywords: z
        .array(createSearchFieldSchema(searchKeywordRule))
        .max(memorySearchMaxKeywordCount)
        .optional()
        .describe(searchKeywordDescription)
})

const memoryStatusDescription =
    '要检索的记忆状态。active 为当前活跃的记忆，通常使用它；' +
    'archived 为已归档（被整理或合并）的旧记忆；all 为两者全部。'

// 主对话工具实例专用：模型显式声明检索范围；召回内部实例不暴露该参数。
export const livingMemorySearchToolInputSchema =
    livingMemorySearchInputSchema.extend({
        memoryStatus: z
            .enum(['active', 'archived', 'all'])
            .describe(memoryStatusDescription)
    })

const memoryIdDescription =
    '要查看来源对话的记忆 ID。使用 living_memory_search 结果中返回的 ID。'

export const livingMemoryGetMessagesInputSchema = z.object({
    memoryId: z.string().trim().min(1).describe(memoryIdDescription)
})
