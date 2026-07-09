import { z } from 'zod'
import { livingMemorySearchMemoryTypes } from '../../../types'

export const livingMemorySearchToolName = 'living_memory_search'
export const livingMemoryGetMessagesToolName = 'living_memory_get_messages'

export const memorySearchMaxTextCount = 5
export const memoryGetMessagesMaxIdCount = 10

export const broadSearchTextRule = {
    fieldName: 'broadSearchTexts',
    minLength: 2,
    maxLength: 6
} as const

export const specificSearchTextRule = {
    fieldName: 'specificSearchTexts',
    minLength: 7,
    maxLength: 20
} as const

export type MemorySearchTextRule =
    | typeof broadSearchTextRule
    | typeof specificSearchTextRule

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

const broadSearchTextDescription =
    `Short broad search phrases. Provide 1 to ${memorySearchMaxTextCount} ` +
    `phrases, each ${formatSearchTextLengthRange(broadSearchTextRule)} ` +
    'characters after trimming.'

const specificSearchTextDescription =
    `Optional longer specific search phrases. Provide 1 to ${memorySearchMaxTextCount} ` +
    `phrases, each ${formatSearchTextLengthRange(specificSearchTextRule)} ` +
    'characters after trimming.'

export const livingMemorySearchInputSchema = z.object({
    broadSearchTexts: z
        .array(createSearchTextSchema(broadSearchTextRule))
        .min(1)
        .max(memorySearchMaxTextCount)
        .describe(broadSearchTextDescription),
    specificSearchTexts: z
        .array(createSearchTextSchema(specificSearchTextRule))
        .min(1)
        .max(memorySearchMaxTextCount)
        .optional()
        .describe(specificSearchTextDescription),
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

export const livingMemorySearchToolInputSchema = z.object({
    broadSearchTexts: z
        .unknown()
        .optional()
        .describe(broadSearchTextDescription),
    specificSearchTexts: z
        .unknown()
        .optional()
        .describe(specificSearchTextDescription),
    memoryTypes: z
        .unknown()
        .optional()
        .describe(
            `Memory categories to search. Use concrete categories or all. Supported values: ${livingMemorySearchMemoryTypes.join(', ')}.`
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

export const livingMemoryGetMessagesToolInputSchema = z.object({
    memoryIds: z.unknown().optional().describe(memoryIdsDescription)
})
