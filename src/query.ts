import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryJobRecord,
    MemoryJobStatus,
    MemorySnapshotRecord,
    UserProfileRecord
} from './types'

export interface PageRequest {
    page?: number
    pageSize?: number
}

export interface MemoryListQuery extends PageRequest {
    presetId: string
    type?: MemoryEntryRecord['type']
    status?: MemoryEntryStatus | 'all'
    keyword?: string
}

export interface SnapshotListQuery extends PageRequest {
    presetId: string
    conversationId?: string
}

export interface JobListQuery extends PageRequest {
    presetId: string
    kind?: MemoryJobRecord['kind']
    status?: MemoryJobStatus
}

export interface UserProfileListQuery extends PageRequest {
    presetId: string
}

export interface PageResult<T> {
    items: T[]
    page: number
    pageSize: number
    total: number
}

const clampPage = (value?: number) => {
    return value != null && value > 0 ? Math.floor(value) : 1
}

const clampPageSize = (value?: number) => {
    if (value == null || value <= 0) {
        return 20
    }

    return Math.min(100, Math.floor(value))
}

const paginate = <T>(
    items: T[],
    page?: number,
    pageSize?: number
): PageResult<T> => {
    const normalizedPage = clampPage(page)
    const normalizedPageSize = clampPageSize(pageSize)
    const start = (normalizedPage - 1) * normalizedPageSize

    return {
        items: items.slice(start, start + normalizedPageSize),
        page: normalizedPage,
        pageSize: normalizedPageSize,
        total: items.length
    }
}

export const filterMemoryList = (
    items: MemoryEntryRecord[],
    query: MemoryListQuery
): PageResult<MemoryEntryRecord> => {
    const keyword = query.keyword?.trim().toLowerCase()

    const filtered = items.filter((item) => {
        if (query.type != null && item.type !== query.type) {
            return false
        }

        if (
            query.status != null &&
            query.status !== 'all' &&
            item.status !== query.status
        ) {
            return false
        }

        if (keyword == null || keyword.length === 0) {
            return true
        }

        return (
            item.content.toLowerCase().includes(keyword) ||
            item.summary?.toLowerCase().includes(keyword) === true ||
            item.sentiment?.toLowerCase().includes(keyword) === true ||
            item.keywords.some((entry) => entry.toLowerCase().includes(keyword))
        )
    })

    const sorted = filtered.sort(
        (left, right) => +right.updatedAt - +left.updatedAt
    )
    return paginate(sorted, query.page, query.pageSize)
}

export const filterSnapshotList = (
    items: MemorySnapshotRecord[],
    query: SnapshotListQuery
): PageResult<MemorySnapshotRecord> => {
    const filtered = items.filter((item) => {
        if (
            query.conversationId != null &&
            item.conversationId !== query.conversationId
        ) {
            return false
        }

        return true
    })

    const sorted = filtered.sort(
        (left, right) => +right.createdAt - +left.createdAt
    )
    return paginate(sorted, query.page, query.pageSize)
}

export const filterJobList = (
    items: MemoryJobRecord[],
    query: JobListQuery
): PageResult<MemoryJobRecord> => {
    const filtered = items.filter((item) => {
        if (query.kind != null && item.kind !== query.kind) {
            return false
        }

        if (query.status != null && item.status !== query.status) {
            return false
        }

        return true
    })

    const sorted = filtered.sort(
        (left, right) => +right.createdAt - +left.createdAt
    )
    return paginate(sorted, query.page, query.pageSize)
}

export const filterUserProfileList = (
    items: UserProfileRecord[],
    query: UserProfileListQuery
): PageResult<UserProfileRecord> => {
    const sorted = items.sort((left, right) => {
        if (+right.updatedAt !== +left.updatedAt) {
            return +right.updatedAt - +left.updatedAt
        }

        return left.speakerLabel.localeCompare(right.speakerLabel)
    })

    return paginate(sorted, query.page, query.pageSize)
}
