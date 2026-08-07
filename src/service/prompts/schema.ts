import { z } from 'zod'
import { memoryEntryTypes } from '../../contracts/memory'
import type {
    MemoryMutationInput,
    UserProfileInput
} from '../../contracts/memory'
import type { ExtractedMemoryItem } from '../../contracts/workflows'
import { MAX_MEMORY_KEYWORDS } from '../memory/entry_fields'

/**
 * 模型输出契约的单一真相源。
 *
 * 这里的 Zod Schema 与示例对象共同定义模型应当通过结果工具提交的参数形状。
 * 示例用目标业务类型和对应运行时 Schema 双重约束，再由 JSON.stringify 生成
 * 提示词里展示的格式串，从而保证：
 *   1. 字段重命名、删除或阶段操作变化会在编译期报错，强制同步；
 *   2. 提示词展示的格式与代码理解的形状不会各自漂移。
 *
 * 修改此处字段时，必须同步更新对应提示词和业务校验器。
 */

type GeneratedMemoryFieldName = Exclude<keyof MemoryMutationInput, 'status'>
type CompleteMemoryOutput<T extends MemoryMutationInput> = {
    [K in GeneratedMemoryFieldName]-?: NonNullable<T[K]>
}

const extractionExample = {
    type: 'fact',
    content: '...',
    summary: '...',
    keywords: ['...'],
    sentiment: '...',
    importance: 0.5
} satisfies CompleteMemoryOutput<ExtractedMemoryItem>

const requiredText = (description: string) =>
    z.string().trim().min(1).describe(description)
const memoryKeywordsSchema = z
    .array(requiredText('非空记忆关键词'))
    .max(MAX_MEMORY_KEYWORDS)
    .describe(`记忆关键词，最多 ${MAX_MEMORY_KEYWORDS} 个`)

export const extractionResultToolName = 'living_memory_extraction_result'
export const extractionResultToolDescription =
    '提交本次对话中提取出的长期记忆。没有可提取内容时提交空 memories 数组。'

export const extractedMemorySchema = z.object({
    type: z.enum(memoryEntryTypes).describe('记忆类型'),
    content: requiredText('完整的第一人称长期记忆正文'),
    summary: requiredText('简短且适合检索的语义摘要'),
    keywords: memoryKeywordsSchema,
    sentiment: requiredText('简短的情绪色彩'),
    importance: z.number().finite().min(0).max(1).describe('0 到 1 的重要程度')
})

export const extractionResultSchema = z.object({
    memories: z.array(extractedMemorySchema).describe('本次提取出的长期记忆')
})
const extractionResultExample = {
    memories: [extractionExample]
} satisfies z.input<typeof extractionResultSchema>

const createDreamMemoryExample = (
    importance: number
): CompleteMemoryOutput<MemoryMutationInput> => ({
    type: 'fact',
    content: '...',
    summary: '...',
    keywords: ['...'],
    sentiment: '...',
    importance
})

const dreamGeneratedMemorySchema = extractedMemorySchema.extend({
    keywords: memoryKeywordsSchema.min(1)
})
const memoryIdSchema = requiredText('来自当前 memory_entries 的记忆 id')
const memoryIdsSchema = z.array(memoryIdSchema).min(1)
const operationReasonSchema = requiredText('执行该操作的简短原因')

const dreamKeepOperationSchema = z.object({
    action: z.literal('keep'),
    memoryIds: memoryIdsSchema,
    reason: operationReasonSchema
})
const dreamUpdateOperationSchema = z.object({
    action: z.literal('update'),
    memoryId: memoryIdSchema,
    memory: dreamGeneratedMemorySchema,
    reason: operationReasonSchema
})
const dreamMergeOperationSchema = z.object({
    action: z.literal('merge'),
    targetMemoryId: memoryIdSchema,
    sourceMemoryIds: memoryIdsSchema,
    memory: dreamGeneratedMemorySchema,
    reason: operationReasonSchema
})
const dreamArchiveOperationSchema = z.object({
    action: z.literal('archive'),
    memoryId: memoryIdSchema,
    reason: operationReasonSchema
})
const dreamDeleteSourceOperationSchema = z.object({
    action: z.literal('deleteSource'),
    targetMemoryId: memoryIdSchema,
    sourceMemoryIds: memoryIdsSchema,
    reason: operationReasonSchema
})

export const dreamResultToolName = 'living_memory_dream_result'
export const dreamResultToolDescription =
    '提交当前 Dream 记忆簇的整理操作。没有可执行操作时提交空 operations 数组。'

export const dreamActiveResultSchema = z.object({
    operations: z.array(
        z.discriminatedUnion('action', [
            dreamKeepOperationSchema,
            dreamUpdateOperationSchema,
            dreamMergeOperationSchema,
            dreamArchiveOperationSchema
        ])
    )
})

export const dreamArchivedResultSchema = z.object({
    operations: z.array(
        z.discriminatedUnion('action', [
            dreamKeepOperationSchema,
            dreamUpdateOperationSchema,
            dreamMergeOperationSchema,
            dreamDeleteSourceOperationSchema
        ])
    )
})

type RequiredSchemaOutput<Schema extends z.ZodTypeAny> = Required<
    z.output<Schema>
>
type DreamGeneratedMemory = CompleteMemoryOutput<MemoryMutationInput>

export type DreamOperation =
    | RequiredSchemaOutput<typeof dreamKeepOperationSchema>
    | (Omit<
          RequiredSchemaOutput<typeof dreamUpdateOperationSchema>,
          'memory'
      > & { memory: DreamGeneratedMemory })
    | (Omit<
          RequiredSchemaOutput<typeof dreamMergeOperationSchema>,
          'memory'
      > & { memory: DreamGeneratedMemory })
    | RequiredSchemaOutput<typeof dreamArchiveOperationSchema>
    | RequiredSchemaOutput<typeof dreamDeleteSourceOperationSchema>

const dreamActiveOperations = [
    { action: 'keep', memoryIds: ['...'], reason: '...' },
    {
        action: 'update',
        memoryId: '...',
        memory: createDreamMemoryExample(0.5),
        reason: '...'
    },
    {
        action: 'merge',
        targetMemoryId: '...',
        sourceMemoryIds: ['...'],
        memory: createDreamMemoryExample(0.8),
        reason: '...'
    },
    {
        action: 'archive',
        memoryId: '...',
        reason: '...'
    }
] satisfies z.input<typeof dreamActiveResultSchema>['operations']

const dreamArchivedOperations = [
    { action: 'keep', memoryIds: ['...'], reason: '...' },
    {
        action: 'update',
        memoryId: '...',
        memory: createDreamMemoryExample(0.4),
        reason: '...'
    },
    {
        action: 'merge',
        targetMemoryId: '...',
        sourceMemoryIds: ['...'],
        memory: createDreamMemoryExample(0.5),
        reason: '...'
    },
    {
        action: 'deleteSource',
        targetMemoryId: '...',
        sourceMemoryIds: ['...'],
        reason: 'merge source 已压缩进 target'
    }
] satisfies z.input<typeof dreamArchivedResultSchema>['operations']

// 画像 Schema 会在调用期绑定 speakerLabel；System 示例保持静态占位符，
// 避免把用户提供的标签插入静态规则消息。
const userProfileExample = {
    speakerLabel: '<speaker_label>',
    content: '...',
    sourceMemoryIds: ['...']
} satisfies Pick<
    UserProfileInput,
    'speakerLabel' | 'content' | 'sourceMemoryIds'
>

export const userProfileResultToolName = 'living_memory_user_profile_result'
export const userProfileResultToolDescription =
    '提交当前用户画像的更新结果。无需更新时提交空 profiles 数组。'

export const createUserProfileResultSchema = (options: {
    speakerLabel: string
    allowedSourceMemoryIds: readonly string[]
}) => {
    const allowedSourceMemoryIds = new Set(options.allowedSourceMemoryIds)
    const sourceMemoryIdSchema = requiredText('画像引用的来源记忆 id').refine(
        (id) => allowedSourceMemoryIds.has(id),
        '来源记忆 id 不在当前画像允许的集合中'
    )

    return z.object({
        profiles: z
            .array(
                z.object({
                    speakerLabel: z
                        .literal(options.speakerLabel)
                        .describe('必须严格等于当前画像 speaker 的完整文本'),
                    content: requiredText('完整的第一人称用户画像内容'),
                    sourceMemoryIds: z
                        .array(sourceMemoryIdSchema)
                        .min(1)
                        .describe('当前画像引用的来源记忆 id')
                })
            )
            .max(1)
            .describe('当前 speaker 的用户画像；无需更新时为空数组')
    })
}

/** 抽取提示词中展示的结果工具参数格式串。 */
export const EXTRACTION_OUTPUT_FORMAT = JSON.stringify(extractionResultExample)

/** Dream active 阶段展示的结果工具参数格式串。 */
export const DREAM_ACTIVE_FORMAT = JSON.stringify({
    operations: dreamActiveOperations
})

/** Dream archived 阶段展示的结果工具参数格式串。 */
export const DREAM_ARCHIVED_FORMAT = JSON.stringify({
    operations: dreamArchivedOperations
})

/** 用户画像结果工具参数中展示的 JSON 格式串。 */
export const USER_PROFILE_OUTPUT_FORMAT = JSON.stringify({
    profiles: [userProfileExample]
})
