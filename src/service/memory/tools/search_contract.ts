import { z } from 'zod'
import { livingMemorySearchMemoryTypes } from '../../../contracts/memory'

export const livingMemorySearchToolName = 'living_memory_search'
export const livingMemoryGetMessagesToolName = 'living_memory_get_messages'

export const memorySearchMaxTextCount = 5
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
    return `${rule.minLength} to ${rule.maxLength}`
}

export const formatSearchTextLengthError = (rule: MemorySearchTextRule) => {
    return `Each ${rule.fieldName} item must be ${formatSearchTextLengthRange(rule)} characters after trimming.`
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
    `Semantic query phrases. Provide 1 to ${memorySearchMaxTextCount} ` +
    `phrases, each ${formatSearchTextLengthRange(searchTextRule)} ` +
    'characters after trimming. Use broad topics, concrete descriptions, or factual phrases.'

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
                message: 'memoryTypes cannot mix all with other types.'
            }
        )
        .describe(
            'Memory categories to search. Use concrete categories or all.'
        )
})

const memoryIdsDescription =
    `Memory ids to inspect. Provide 1 to ${memoryGetMessagesMaxIdCount} ids ` +
    'from living_memory_search results.'

export const livingMemoryGetMessagesInputSchema = z.object({
    memoryIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(memoryGetMessagesMaxIdCount)
        .describe(memoryIdsDescription)
})
