import { computed, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import * as api from '../api'
import {
    type MemoryEntryRecord,
    type MemoryEntryStatus,
    type MemoryEntryType,
    memoryEntryTypes,
    type MemoryListFacets,
    type MemoryListFilter,
    type MemoryListResult
} from '../types'
import { usePagedResource } from './use-paged-resource'

const createEmptyTypeCounts = (): Record<MemoryEntryType, number> => {
    return Object.fromEntries(
        memoryEntryTypes.map((type) => [type, 0])
    ) as Record<MemoryEntryType, number>
}

export const createEmptyMemoryListFacets = (): MemoryListFacets => {
    return {
        statuses: {
            active: 0,
            archived: 0,
            all: 0
        },
        types: {
            active: createEmptyTypeCounts(),
            archived: createEmptyTypeCounts(),
            all: createEmptyTypeCounts()
        }
    }
}

export function useMemoryList(presetId: Readonly<Ref<string>>) {
    const keyword = ref('')
    const memoryType = ref<MemoryEntryType | ''>('')
    const status = ref<MemoryEntryStatus | 'all'>('active')
    const speakerKey = ref('')
    const facets = shallowRef<MemoryListFacets>(createEmptyMemoryListFacets())

    // 筛选参数的唯一构造点：列表查询与"全选筛选结果"共用同一口径。
    const currentFilter = computed<MemoryListFilter>(() => ({
        presetId: presetId.value,
        keyword: keyword.value.trim() || undefined,
        type: memoryType.value || undefined,
        status: status.value,
        speakerKey: speakerKey.value || undefined
    }))

    const resource = usePagedResource<MemoryEntryRecord, MemoryListResult>(
        async (page, pageSize) => {
            return await api.listMemories({
                ...currentFilter.value,
                page,
                pageSize
            })
        }
    )

    const refresh = async (
        resetPage = false
    ): Promise<MemoryListResult | null> => {
        if (presetId.value.length === 0) {
            clear()
            return null
        }

        const result = await resource.refresh(resetPage)
        facets.value = result.facets
        return result
    }

    const clear = () => {
        resource.clear()
        facets.value = createEmptyMemoryListFacets()
    }

    const changePage = async (
        value: number
    ): Promise<MemoryListResult | null> => {
        resource.page.value = value
        return await refresh()
    }

    const changePageSize = async (
        value: number
    ): Promise<MemoryListResult | null> => {
        resource.pageSize.value = value
        return await refresh(true)
    }

    const resetFilters = () => {
        keyword.value = ''
        memoryType.value = ''
        status.value = 'active'
        speakerKey.value = ''
    }

    const getStatusCount = (value: MemoryEntryStatus | 'all'): number => {
        return facets.value.statuses[value]
    }

    const getTypeCount = (value: MemoryEntryType | ''): number => {
        if (value === '') {
            return facets.value.statuses[status.value]
        }
        return facets.value.types[status.value][value]
    }

    return {
        ...resource,
        keyword,
        memoryType,
        status,
        speakerKey,
        currentFilter,
        facets,
        refresh,
        changePage,
        changePageSize,
        clear,
        resetFilters,
        getStatusCount,
        getTypeCount
    }
}
