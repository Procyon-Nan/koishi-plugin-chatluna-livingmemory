import type { MemoryEntryRecord } from '../../contracts/memory'

const toIsoString = (value: Date | string | number) => {
    const date = new Date(value)
    return Number.isFinite(+date) ? date.toISOString() : ''
}

export const formatMemoryEntryForPrompt = (entry: MemoryEntryRecord) => {
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
