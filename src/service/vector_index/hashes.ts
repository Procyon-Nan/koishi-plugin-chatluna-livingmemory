import { createHash } from 'node:crypto'
import type { MemoryIndexSourceRecord } from '../../contracts/vector_index'

export const createMemoryContentHash = (content: string) => {
    return createHash('sha256').update(content).digest('hex')
}

export const normalizeIndexedKeywords = (keywords: string[]) => {
    const normalized = new Set<string>()
    for (const keyword of keywords) {
        const value = keyword.trim().toLowerCase()
        if (value.length > 0) {
            normalized.add(value)
        }
    }
    return [...normalized].sort()
}

export const createMemoryKeywordsHash = (keywords: string[]) => {
    return createHash('sha256')
        .update(JSON.stringify(normalizeIndexedKeywords(keywords)))
        .digest('hex')
}

export const createMemoryIndexHashes = (
    source: Pick<MemoryIndexSourceRecord, 'content' | 'keywords'>
) => ({
    contentHash: createMemoryContentHash(source.content),
    keywordsHash: createMemoryKeywordsHash(source.keywords)
})
