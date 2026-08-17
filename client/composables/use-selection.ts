import { computed, ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 管理 id 集合的勾选状态，供列表批量操作使用。
 * 通过整体替换 Set 触发响应式更新。
 */
export function useSelection() {
    const selectedIds: Ref<ReadonlySet<string>> = ref(new Set())

    const selectedCount = computed(() => selectedIds.value.size)

    const isSelected = (id: string) => selectedIds.value.has(id)

    const toggleSelected = (id: string) => {
        const next = new Set(selectedIds.value)
        if (next.has(id)) {
            next.delete(id)
        } else {
            next.add(id)
        }
        selectedIds.value = next
    }

    const selectAll = (ids: readonly string[]) => {
        selectedIds.value = new Set(ids)
    }

    const clearSelection = () => {
        selectedIds.value = new Set()
    }

    return {
        selectedIds,
        selectedCount,
        isSelected,
        toggleSelected,
        selectAll,
        clearSelection
    }
}
