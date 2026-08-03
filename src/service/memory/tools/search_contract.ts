import { z } from 'zod'
import { livingMemorySearchMemoryTypes } from '../../../contracts/memory'

export const livingMemorySearchToolName = 'living_memory_search'
export const livingMemoryGetMessagesToolName = 'living_memory_get_messages'

export const memorySearchMaxTextCount = 6
export const memoryGetMessagesMaxIdCount = 10

export const searchTextRule = {
    fieldName: 'searchTexts',
    minLength: 2,
    maxLength: 100
} as const

export type MemorySearchTextRule = typeof searchTextRule

export const normalizeSearchText = (value: string) => {
    return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

export const countSearchTextCharacters = (value: string) => {
    return Array.from(normalizeSearchText(value)).length
}

export const formatSearchTextLengthRange = (rule: MemorySearchTextRule) => {
    return `${rule.minLength} 到 ${rule.maxLength}`
}

export const formatSearchTextLengthError = (rule: MemorySearchTextRule) => {
    return `${rule.fieldName} 的每个条目在去除首尾空白后必须是 ${formatSearchTextLengthRange(rule)} 个字符。`
}

const createSearchTextSchema = (rule: MemorySearchTextRule) =>
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
    `语义查询短语。提供 1 到 ${memorySearchMaxTextCount} 条短语，` +
    `每条在去除首尾空白后为 ${formatSearchTextLengthRange(searchTextRule)} 个字符。` +
    '使用宽泛的话题、具体的描述或事实性表述。'

export const livingMemoryEmbeddingSearchInputSchema = z.object({
    searchTexts: z
        .array(createSearchTextSchema(searchTextRule))
        .min(1)
        .max(memorySearchMaxTextCount)
        .describe(searchTextDescription),
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
