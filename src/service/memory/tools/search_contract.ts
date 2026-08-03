import { z } from 'zod'
import { livingMemorySearchMemoryTypes } from '../../../contracts/memory'

export const livingMemorySearchToolName = 'living_memory_search'
export const livingMemoryGetMessagesToolName = 'living_memory_get_messages'

export const memorySearchMaxTextCount = 3
export const memorySearchMaxKeywordCount = 3
export const memoryGetMessagesMaxIdCount = 10

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
    z.string().refine(
        (value) => {
            const length = countSearchTextCharacters(value)
            return length >= rule.minLength && length <= rule.maxLength
        },
        {
            message: formatSearchTextLengthError(rule)
        }
    )

const searchTextDescription =
    `用于语义检索的第一人称查询短语。提供 1 到 ${memorySearchMaxTextCount} 条短语，` +
    `每条在去除首尾空白后为 ${formatSearchTextLengthRange(searchTextRule)} 个字符。` +
    '必须包含完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等），' +
    '使用第一人称的自然语言描述。不同的查询短语应覆盖不同的语义角度。'

const searchKeywordDescription =
    `用于关键词匹配的精确关键词。提供 0 到 ${memorySearchMaxKeywordCount} 个关键词，` +
    `每个在去除首尾空白后为 ${formatSearchTextLengthRange(searchKeywordRule)} 个字符。` +
    '关键词应为具体实体、名称或术语，不应是完整句子。'

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
        .describe(searchKeywordDescription),
    memoryTypes: z
        .array(z.enum(livingMemorySearchMemoryTypes))
        .min(1)
        .refine(
            (memoryTypes) =>
                !memoryTypes.includes('all') || memoryTypes.length === 1,
            {
                message: 'memoryTypes 不能将 all 与其他类别混用。'
            }
        )
        .describe('要搜索的记忆类别。使用具体类别或 all。')
})

const memoryIdsDescription =
    `要查看的记忆 ID。提供 1 到 ${memoryGetMessagesMaxIdCount} 个 ` +
    '来自 living_memory_search 结果的 ID。'

export const livingMemoryGetMessagesInputSchema = z.object({
    memoryIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(memoryGetMessagesMaxIdCount)
        .describe(memoryIdsDescription)
})
