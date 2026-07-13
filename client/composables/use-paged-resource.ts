import { ref, shallowRef } from 'vue'
import type { PageResult } from '../types'

export type PageLoader<T, TResult extends PageResult<T>> = (
    page: number,
    pageSize: number
) => Promise<TResult>

export function usePagedResource<
    T,
    TResult extends PageResult<T> = PageResult<T>
>(loader: PageLoader<T, TResult>, initialPageSize = 20) {
    const items = shallowRef<T[]>([])
    const page = ref(1)
    const pageSize = ref(initialPageSize)
    const total = ref(0)
    const loading = ref(false)

    const refresh = async (resetPage = false): Promise<TResult> => {
        if (resetPage) {
            page.value = 1
        }

        loading.value = true
        try {
            const result = await loader(page.value, pageSize.value)
            items.value = result.items
            page.value = result.page
            pageSize.value = result.pageSize
            total.value = result.total
            return result
        } finally {
            loading.value = false
        }
    }

    const changePage = async (value: number): Promise<TResult> => {
        page.value = value
        return await refresh()
    }

    const changePageSize = async (value: number): Promise<TResult> => {
        pageSize.value = value
        return await refresh(true)
    }

    const clear = () => {
        items.value = []
        page.value = 1
        total.value = 0
    }

    return {
        items,
        page,
        pageSize,
        total,
        loading,
        refresh,
        changePage,
        changePageSize,
        clear
    }
}
