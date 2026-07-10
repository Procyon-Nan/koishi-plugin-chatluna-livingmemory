import type {
    MemoryEntryRecord,
    MemoryEntryType
} from '../../../contracts/memory'
import { memoryEntryTypes } from '../../../contracts/memory'

export const MAX_CLUSTER_SIZE = 8
export const MAX_BUCKET_SIZE = 64
export const MAX_DREAM_CLUSTERS = 32
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.84
export const STRONG_KEYWORD_OVERLAP = 2

export const neutralSentiments = new Set([
    '中性',
    '无',
    '无明显情绪',
    'none',
    'neutral'
])

export const normalizeText = (value: string) => value.trim()

export const normalizeTerm = (value: string) => value.trim().toLowerCase()

export const unique = <T>(items: T[]) => Array.from(new Set(items))

export const parseImportance = (value: unknown): number | undefined => {
    const importance =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim().length > 0
              ? Number(value.trim())
              : Number.NaN

    if (!Number.isFinite(importance)) {
        return undefined
    }

    return Math.min(1, Math.max(0, importance))
}

export const isMemoryEntryType = (value: string): value is MemoryEntryType => {
    return (memoryEntryTypes as readonly string[]).includes(value)
}

export const toTimestamp = (value: Date | string | number) => {
    const timestamp = +new Date(value)
    return Number.isFinite(timestamp) ? timestamp : 0
}

export const toMonthBucket = (value: Date | string | number) => {
    const date = new Date(value)
    if (!Number.isFinite(+date)) {
        return 'unknown'
    }

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
        2,
        '0'
    )}`
}

export const toIsoString = (value: Date | string | number) => {
    const date = new Date(value)
    return Number.isFinite(+date) ? date.toISOString() : ''
}

export const toPromptEntry = (entry: MemoryEntryRecord) => {
    return [
        `id=${entry.id}`,
        `type=${entry.type}`,
        `status=${entry.status}`,
        `createdAt=${toIsoString(entry.createdAt)}`,
        `updatedAt=${toIsoString(entry.updatedAt)}`,
        `sentiment=${entry.sentiment ?? ''}`,
        `importance=${entry.importance ?? ''}`,
        `keywords=${entry.keywords.join('、')}`,
        `summary=${entry.summary ?? ''}`,
        'content:',
        entry.content
    ].join('\n')
}

export const keywordSet = (entry: MemoryEntryRecord) => {
    return new Set(entry.keywords.map(normalizeTerm).filter(Boolean))
}

export const keywordOverlap = (
    left: MemoryEntryRecord,
    right: MemoryEntryRecord
) => {
    const leftKeywords = keywordSet(left)
    if (leftKeywords.size === 0) {
        return 0
    }

    let count = 0
    for (const keyword of keywordSet(right)) {
        if (leftKeywords.has(keyword)) {
            count++
        }
    }

    return count
}

export class UnionFind {
    private readonly parent = new Map<string, string>()

    constructor(ids: string[]) {
        ids.forEach((id) => this.parent.set(id, id))
    }

    find(id: string): string {
        const parent = this.parent.get(id)
        if (parent == null || parent === id) {
            return id
        }

        const root = this.find(parent)
        this.parent.set(id, root)
        return root
    }

    union(left: string, right: string) {
        const leftRoot = this.find(left)
        const rightRoot = this.find(right)
        if (leftRoot !== rightRoot) {
            this.parent.set(rightRoot, leftRoot)
        }
    }

    groups(entries: MemoryEntryRecord[]) {
        const byRoot = new Map<string, MemoryEntryRecord[]>()
        for (const entry of entries) {
            const root = this.find(entry.id)
            const group = byRoot.get(root) ?? []
            group.push(entry)
            byRoot.set(root, group)
        }

        return [...byRoot.values()].filter((group) => group.length >= 2)
    }
}
