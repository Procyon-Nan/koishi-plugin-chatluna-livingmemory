import type { DreamMemoryEntryRecord } from '../../contracts/workflows'

export const formatMemoryEntryForPrompt = (entry: DreamMemoryEntryRecord) => {
    return [
        `id=${entry.id}`,
        `type=${entry.type}`,
        `createdAt=${entry.createdAt.toISOString()}`,
        `updatedAt=${entry.updatedAt.toISOString()}`,
        `sentiment=${entry.sentiment ?? ''}`,
        `importance=${entry.importance ?? ''}`,
        `keywords=${entry.keywords.join('、')}`,
        `summary=${entry.summary ?? ''}`,
        'content:',
        entry.content
    ].join('\n')
}
