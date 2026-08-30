import { z } from 'zod'
import { memoryEntryTypes } from '../../contracts/memory'
import type {
    MemoryMutationInput,
    UserProfileInput
} from '../../contracts/memory'
import { MAX_MEMORY_KEYWORDS } from '../memory/entry_fields'

/**
 * 模型输出契约的单一真相源。
 *
 * Zod Schema 同时定义结果工具的参数形状、字段说明和运行时校验。
 * Dream 与用户画像的格式示例由目标业务类型约束，再由 JSON.stringify 生成，
 * 从而保证：
 *   1. 字段重命名、删除或阶段操作变化会在编译期报错，强制同步；
 *   2. 提示词展示的格式与代码理解的形状不会各自漂移。
 */

type GeneratedMemoryFieldName = Exclude<keyof MemoryMutationInput, 'status'>
type CompleteMemoryOutput<T extends MemoryMutationInput> = {
    [K in GeneratedMemoryFieldName]-?: NonNullable<T[K]>
}

const requiredText = (description: string) =>
    z.string().trim().min(1).describe(description)

export const extractionResultToolName = 'living_memory_extraction_result'
export const extractionResultToolDescription =
    '提交本次记录的长期记忆。没有可记录的记忆时提交空 memories 数组。'

export const generatedMemorySchema = z
    .object({
        type: z.enum(memoryEntryTypes).describe(
            [
                `必须取以下之一（${memoryEntryTypes.join('|')}）：`,
                '- identity：用户或是你自己的稳定身份信息，如身份、角色、长期属性。',
                '- preference：用户或是你自己的长期偏好、习惯、喜恶。',
                '- fact：已确认的客观事实，如事件、需求、状态，通常关联具体昵称与时间。',
                '- plan：尚未发生、面向未来的计划、约定或待办。',
                '- context：当前对话的背景或短期情境，参考价值随时间衰减。',
                '- other：无法归入以上类别但仍值得长期记住的信息。'
            ].join('\n')
        ),
        content: requiredText(
            '记忆正文。必须使用你的第一人称视角，体现你的人格、语气、关注点与关系态度，口语化且自然地描述你的认识，或与某个人之间的互动、关系、事实或偏好，追求详略得当，避免流水账；字数保持在 300 字以内。'
        ),
        summary: requiredText(
            '利于语义检索的概括性摘要。必须使用你的第一人称视角，简短、清晰、准确；避免颜文字、口癖、吐槽、抒情、语气化和长句。'
        ),
        keywords: z
            .array(requiredText('记忆的关键词。'))
            .min(1)
            .max(MAX_MEMORY_KEYWORDS)
            .describe(
                `使用 1 到 ${MAX_MEMORY_KEYWORDS} 个关键词刻画记忆的核心主题。`
            ),
        sentiment: requiredText(
            '简短的情绪标注词。可使用“担心”、“亲近”、“愉快”、“疲惫”、“平静”等词；没有明显情绪时可写“平静”。'
        ),
        importance: z
            .number()
            .finite()
            .min(0)
            .max(1)
            .describe(
                '记忆的重要性。使用 0 到 1 之间的数字，数字越大表示重要性越高。'
            )
    })
    .describe(
        '在记忆中描述某个用户时，必须使用当前输入材料中的具体用户昵称。避免用“用户”、“对方”等泛化词汇或用户 ID 替代，也不要把多个不同用户混成同一个人。'
    )

export const createExtractionResultSchema = (
    allowedSpeakerLabels: readonly string[]
) => {
    const allowed = new Set(allowedSpeakerLabels)
    return z.object({
        memories: z.array(
            generatedMemorySchema.extend({
                speakerLabels: z
                    .array(
                        requiredText('对话中出现的用户昵称').refine(
                            (label) => allowed.has(label),
                            '用户昵称不在当前对话中'
                        )
                    )
                    .describe(
                        '这条记忆内容实际关联的用户昵称。只涉及当前角色自身且不关联具体用户时填写空数组。' +
                            '只能填写 transcript 中用户消息前缀里出现的完整昵称；涉及多名用户时全部填写；' +
                            '不要填写助手昵称，也不要因为用户出现在 transcript 中就自动关联。'
                    )
            })
        )
    })
}
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
    memory: generatedMemorySchema,
    reason: operationReasonSchema
})
const dreamMergeOperationSchema = z.object({
    action: z.literal('merge'),
    targetMemoryId: memoryIdSchema,
    sourceMemoryIds: memoryIdsSchema,
    memory: generatedMemorySchema,
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
      > & {
          memory: DreamGeneratedMemory
      })
    | (Omit<
          RequiredSchemaOutput<typeof dreamMergeOperationSchema>,
          'memory'
      > & {
          memory: DreamGeneratedMemory
      })
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
