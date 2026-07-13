import type {
    AgenticMemorySnapshotItem,
    MemoryEntryStatus,
    MemoryJobRecord,
    MemorySnapshotRecord,
    MemorySnapshotResolvedItem
} from '../types'

const memoryTypeLabels: Record<string, string> = {
    identity: '身份',
    preference: '偏好',
    fact: '事实',
    plan: '计划',
    context: '上下文',
    other: '其它'
}

const memoryTagTypes: Record<
    string,
    'success' | 'warning' | 'danger' | 'info' | ''
> = {
    identity: '',
    preference: 'success',
    fact: 'info',
    plan: 'warning',
    context: 'danger',
    other: 'info'
}

const jobKindLabels: Record<string, string> = {
    recall: '记忆召回',
    extract: '记忆提取',
    dream: 'Dream 固化',
    clear: '数据清理'
}

const jobStatusLabels: Record<string, string> = {
    pending: '排队中',
    running: '运行中',
    completed: '已完成',
    failed: '已失败'
}

const jobStatusTagTypes: Record<
    string,
    'success' | 'warning' | 'danger' | 'info'
> = {
    pending: 'info',
    running: 'warning',
    completed: 'success',
    failed: 'danger'
}

export const formatTime = (value: string | Date | null | undefined): string => {
    if (!value) return ''
    const date = new Date(value as string | number)
    if (Number.isNaN(date.getTime())) return String(value)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}`
}

export const formatImportance = (value: number | null | undefined): string => {
    if (value == null) return ''
    return Number.isFinite(value) ? value.toFixed(2) : ''
}

export const formatScore = (value: number | null | undefined): string => {
    if (value == null) return '-'
    return Number.isFinite(value) ? value.toFixed(4) : String(value)
}

export const getMemoryTypeLabel = (type: string): string => {
    return memoryTypeLabels[type] ?? type
}

export const getMemoryTagType = (
    type: string
): 'success' | 'warning' | 'danger' | 'info' | '' => {
    return memoryTagTypes[type] ?? 'info'
}

export const getMemoryStatusLabel = (status: MemoryEntryStatus): string => {
    return status === 'archived' ? '归档' : '活跃'
}

export const clampImportance = (
    value: number | null | undefined
): number | null => {
    if (value == null || !Number.isFinite(value)) {
        return null
    }

    return Math.min(1, Math.max(0, value))
}

export const getImportanceTone = (
    value: number | null | undefined
): 'high' | 'medium' | 'low' | 'empty' => {
    const normalized = clampImportance(value)
    if (normalized == null) return 'empty'
    if (normalized >= 0.7) return 'high'
    if (normalized >= 0.4) return 'medium'
    return 'low'
}

export const formatImportancePercent = (
    value: number | null | undefined
): string => {
    const normalized = clampImportance(value)
    return normalized == null ? '0%' : `${Math.round(normalized * 100)}%`
}

export const getJobKindLabel = (kind: string): string => {
    return jobKindLabels[kind] ?? kind
}

export const formatJobRecallStrategy = (
    strategy: MemoryJobRecord['recallStrategy']
): string => {
    return strategy ?? '-'
}

export const getJobStatusLabel = (status: string): string => {
    return jobStatusLabels[status] ?? status
}

export const getJobStatusTagType = (
    status: string
): 'success' | 'warning' | 'danger' | 'info' => {
    return jobStatusTagTypes[status] ?? 'info'
}

export const isAgenticSnapshotItem = (
    item: MemorySnapshotRecord['items'][number]
): item is AgenticMemorySnapshotItem => {
    return 'finalText' in item
}

export const snapshotAgenticItems = (
    snapshot: MemorySnapshotRecord
): AgenticMemorySnapshotItem[] => {
    return snapshot.items.filter(isAgenticSnapshotItem)
}

export const isAgenticSnapshot = (snapshot: MemorySnapshotRecord): boolean => {
    return snapshot.strategy === 'agentic-recall'
}

export const snapshotHitCount = (snapshot: MemorySnapshotRecord): number => {
    if (isAgenticSnapshot(snapshot)) {
        return snapshotAgenticItems(snapshot).reduce(
            (total, item) => total + item.matchedMemories.length,
            0
        )
    }

    return snapshot.resolvedItems.length
}

export const formatSearchTexts = (
    value: readonly string[] | null | undefined
): string => {
    return value == null || value.length === 0 ? '-' : value.join('、')
}

export const snapshotItemStatusLabel = (
    item: MemorySnapshotResolvedItem
): string => {
    if (item.missing) return '缺失'
    return item.memory?.status === 'archived' ? '历史' : '活跃'
}

export const snapshotItemTagType = (
    item: MemorySnapshotResolvedItem
): 'success' | 'info' | 'danger' => {
    if (item.missing) return 'danger'
    return item.memory?.status === 'archived' ? 'info' : 'success'
}
