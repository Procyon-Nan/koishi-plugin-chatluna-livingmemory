import { memoryEntryTypes } from './contracts/memory'
import type {
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord,
    MemorySnapshotRecord,
    UserProfileRecord
} from './contracts/memory'
import type {
    JobListQuery,
    MemoryListFacets,
    MemoryListFilter,
    MemoryListQuery,
    MemoryListResult,
    PageResult,
    SnapshotListQuery,
    UserProfileListQuery
} from './contracts/rpc'

export type {
    JobListQuery,
    MemoryListFilter,
    MemoryListQuery,
    MemoryListResult,
    PageRequest,
    PageResult,
    SnapshotListQuery,
    UserProfileListQuery
} from './contracts/rpc'

const clampPage = (value?: number) => {
    return value != null && value > 0 ? Math.floor(value) : 1
}

const createEmptyMemoryTypeCounts = (): Record<MemoryEntryType, number> => {
    return Object.fromEntries(
        memoryEntryTypes.map((type) => [type, 0])
    ) as Record<MemoryEntryType, number>
}

export const createMemoryListFacets = (
    items: MemoryEntryRecord[]
): MemoryListFacets => {
    const statuses = {
        active: 0,
        archived: 0,
        all: items.length
    } satisfies Record<MemoryEntryStatus | 'all', number>
    const types = {
        active: createEmptyMemoryTypeCounts(),
        archived: createEmptyMemoryTypeCounts(),
        all: createEmptyMemoryTypeCounts()
    } satisfies MemoryListFacets['types']

    for (const item of items) {
        statuses[item.status] += 1
        types[item.status][item.type] += 1
        types.all[item.type] += 1
    }

    return { statuses, types }
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

const selectMemoryMatches = (
    items: MemoryEntryRecord[],
    filter: MemoryListFilter
): MemoryEntryRecord[] => {
    const keyword = filter.keyword?.trim().toLowerCase()

    return items.filter((item) => {
        const matchesFilters =
            (filter.type == null || item.type === filter.type) &&
            (filter.speakerKey == null ||
                item.speakerKeys.includes(filter.speakerKey)) &&
            (filter.status == null ||
                filter.status === 'all' ||
                item.status === filter.status)
        if (!matchesFilters) {
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
}

/**
 * 按查询条件过滤、排序并分页记忆列表；facet 统计基于过滤前的全集，
 * 供前端在切换筛选时展示各选项条数。
 */
export const filterMemoryList = (
    items: MemoryEntryRecord[],
    query: MemoryListQuery
): MemoryListResult => {
    const facets = createMemoryListFacets(items)
    const sorted = selectMemoryMatches(items, query).sort(
        (left, right) => +right.updatedAt - +left.updatedAt
    )
    return {
        ...paginate(sorted, query.page, query.pageSize),
        facets
    }
}

/**
 * 按筛选条件返回全部匹配记忆的 id（不分页、不排序），
 * 供前端“全选筛选结果”后批量删除使用。
 */
export const filterMemoryIds = (
    items: MemoryEntryRecord[],
    filter: MemoryListFilter
): string[] => {
    return selectMemoryMatches(items, filter).map((item) => item.id)
}

export const filterSnapshotList = (
    items: MemorySnapshotRecord[],
    query: SnapshotListQuery
): PageResult<MemorySnapshotRecord> => {
    const filtered = items.filter(
        (item) =>
            query.conversationId == null ||
            item.conversationId === query.conversationId
    )

    const sorted = filtered.sort(
        (left, right) => +right.createdAt - +left.createdAt
    )
    return paginate(sorted, query.page, query.pageSize)
}

export const filterJobList = (
    items: MemoryJobRecord[],
    query: JobListQuery
): PageResult<MemoryJobRecord> => {
    const filtered = items.filter(
        (item) =>
            (query.kind == null || item.kind === query.kind) &&
            (query.status == null || item.status === query.status)
    )

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
