import type {
    MemoryMutationInput,
    UserProfileInput
} from '../../contracts/memory'
import type { ExtractedMemoryItem } from '../../contracts/workflows'
import type { DreamOperation } from '../workflows/dream/types'

/**
 * 模型输出契约的单一真相源。
 *
 * 这里的示例对象与各工作流解析器共同定义模型应当返回的 JSON 形状。
 * 示例用带类型约束的普通对象描述，再由
 * JSON.stringify 生成提示词里展示的格式串，从而保证：
 *   1. 字段重命名/删除会在编译期报错（见下方 SchemaShape 约束），强制同步；
 *   2. 提示词展示的格式与代码理解的形状不会各自漂移。
 *
 * 修改此处字段时，必须同步更新对应解析器。
 */

// 仅约束“键名必须是目标类型的合法键”，值用占位符（unknown）。
// 字段被改名或删除时，示例里的旧键会变成多余属性而报错。
type SchemaShape<T> = Partial<Record<keyof T, unknown>>

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
] satisfies SchemaShape<DreamOperation>[]

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
] satisfies SchemaShape<DreamOperation>[]

const userProfileExample = {
    speakerLabel: '张三',
    content: '我对张三的理解是……',
    sourceMemoryIds: ['...']
} satisfies Pick<
    UserProfileInput,
    'speakerLabel' | 'content' | 'sourceMemoryIds'
>

/** 抽取提示词中展示的单条记忆 JSON 格式串。 */
export const EXTRACTION_OUTPUT_FORMAT = JSON.stringify(extractionExample)

/** Dream active 阶段展示的 operations JSON 格式串。 */
export const DREAM_ACTIVE_FORMAT = JSON.stringify({
    operations: dreamActiveOperations
})

/** Dream archived 阶段展示的 operations JSON 格式串。 */
export const DREAM_ARCHIVED_FORMAT = JSON.stringify({
    operations: dreamArchivedOperations
})

/** 用户画像提示词中展示的单条画像 JSON 格式串。 */
export const USER_PROFILE_OUTPUT_FORMAT = JSON.stringify(userProfileExample)
