import { memoryEntryTypes } from '../../types'
import type { ExtractedMemoryItem, MemoryMutationInput } from '../../types'
import type { DreamOperation } from '../dream/types'

/**
 * 模型输出契约的单一真相源。
 *
 * 这里的示例对象与解析器（extractor 的 parse、dream/parser.ts）共同定义了
 * 模型应当返回的 JSON 形状。示例用带类型约束的普通对象描述，再由
 * JSON.stringify 生成提示词里展示的格式串，从而保证：
 *   1. 字段重命名/删除会在编译期报错（见下方 SchemaShape 约束），强制同步；
 *   2. 提示词展示的格式与代码理解的形状不会各自漂移。
 *
 * 修改此处字段时，必须同步更新对应解析器。
 */

// 仅约束“键名必须是目标类型的合法键”，值用占位符（unknown）。
// 字段被改名或删除时，示例里的旧键会变成多余属性而报错。
type SchemaShape<T> = Partial<Record<keyof T, unknown>>

// 抽取与 Dream 输出里 type 字段的可选值，直接派生自类型枚举，
// 避免在提示词里手抄字符串而与 memoryEntryTypes 漂移。
export const MEMORY_TYPE_OPTIONS = memoryEntryTypes.join('|')

const extractionExample = {
    type: MEMORY_TYPE_OPTIONS,
    content: '...',
    keywords: ['...'],
    summary: '...',
    sentiment: '...',
    importance: 0.5
} satisfies SchemaShape<ExtractedMemoryItem>

const dreamActiveOperations = [
    { action: 'keep', memoryIds: ['...'], reason: '...' },
    {
        action: 'update',
        memoryId: '...',
        memory: {
            type: 'fact',
            content: '...',
            summary: '...',
            keywords: ['...'],
            sentiment: '...',
            importance: 0.5
        } satisfies SchemaShape<MemoryMutationInput>,
        reason: '...'
    },
    {
        action: 'merge',
        targetMemoryId: '...',
        sourceMemoryIds: ['...'],
        memory: {
            type: 'fact',
            content: '...',
            summary: '...',
            keywords: ['...'],
            sentiment: '...',
            importance: 0.8
        } satisfies SchemaShape<MemoryMutationInput>,
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
        memory: {
            type: 'fact',
            content: '...',
            summary: '...',
            keywords: ['...'],
            sentiment: '...',
            importance: 0.4
        } satisfies SchemaShape<MemoryMutationInput>,
        reason: '...'
    },
    {
        action: 'merge',
        targetMemoryId: '...',
        sourceMemoryIds: ['...'],
        memory: {
            type: 'fact',
            content: '...',
            summary: '...',
            keywords: ['...'],
            sentiment: '...',
            importance: 0.5
        } satisfies SchemaShape<MemoryMutationInput>,
        reason: '...'
    },
    {
        action: 'deleteSource',
        targetMemoryId: '...',
        sourceMemoryIds: ['...'],
        reason: 'merge source 已压缩进 target'
    }
] satisfies SchemaShape<DreamOperation>[]

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
