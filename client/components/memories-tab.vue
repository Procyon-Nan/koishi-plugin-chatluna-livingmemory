<template>
    <div class="memories-workspace">
        <el-card shadow="never" class="category-card">
            <template #header>
                <div class="card-header">
                    <span class="card-title">记忆筛选面板</span>
                </div>
            </template>
            <div class="category-filters-vertical">
                <div class="category-item-vertical">
                    <span class="category-label-vertical">关键词搜索</span>
                    <el-input
                        v-model="keyword"
                        placeholder="输入并回车搜索"
                        clearable
                        class="keyword-input"
                        @keyup.enter="onFilterChange"
                        @clear="onFilterChange"
                    />
                </div>
                <div class="category-item-vertical">
                    <span class="category-label-vertical">关联用户</span>
                    <el-select
                        v-model="speakerKey"
                        placeholder="全部用户"
                        clearable
                        @change="onFilterChange"
                    >
                        <el-option
                            v-for="speaker in speakers"
                            :key="speaker.speakerKey"
                            :label="speaker.speakerLabel"
                            :value="speaker.speakerKey"
                        />
                    </el-select>
                </div>
                <div class="category-item-vertical">
                    <span class="category-label-vertical">状态</span>
                    <div class="category-options-vertical">
                        <button
                            v-for="option in statusOptions"
                            :key="option.value"
                            :class="[
                                'category-btn-vertical',
                                { active: status === option.value }
                            ]"
                            @click="setStatus(option.value)"
                        >
                            <span class="btn-text-content">
                                {{ option.label }}
                            </span>
                            <span class="btn-count-badge">
                                {{ getStatusCount(option.value) }}
                            </span>
                        </button>
                    </div>
                </div>
                <div class="category-item-vertical">
                    <span class="category-label-vertical">类别</span>
                    <div class="category-options-vertical">
                        <button
                            :class="[
                                'category-btn-vertical',
                                { active: memoryType === '' }
                            ]"
                            @click="setMemoryType('')"
                        >
                            <span class="btn-text-content">全部</span>
                            <span class="btn-count-badge">
                                {{ getTypeCount('') }}
                            </span>
                        </button>
                        <button
                            v-for="type in memoryTypes"
                            :key="type"
                            :class="[
                                'category-btn-vertical',
                                { active: memoryType === type }
                            ]"
                            @click="setMemoryType(type)"
                        >
                            <span class="btn-text-content">
                                {{ getMemoryTypeLabel(type) }}
                            </span>
                            <span class="btn-count-badge">
                                {{ getTypeCount(type) }}
                            </span>
                        </button>
                    </div>
                </div>
                <div class="category-reset-container">
                    <button
                        class="reset-filter-btn"
                        @click="resetMemoryFilters"
                    >
                        重置筛选条件
                    </button>
                </div>
            </div>
        </el-card>

        <div class="tab-pane-content">
            <div class="memory-list-panel" v-loading="loading">
                <div class="memory-batch-toolbar">
                    <el-checkbox
                        :model-value="isAllSelected"
                        :indeterminate="isIndeterminate"
                        :disabled="total === 0 || selectAllPending"
                        @change="toggleSelectAll"
                    >
                        全选
                    </el-checkbox>
                    <span class="memory-batch-count">
                        已选 {{ selectedCount }} / {{ total }} 条
                    </span>
                    <div class="memory-batch-actions">
                        <el-button
                            size="small"
                            type="danger"
                            plain
                            :disabled="selectedCount === 0 || batchDeleting"
                            :loading="batchDeleting"
                            @click="removeSelectedMemories"
                        >
                            批量删除
                        </el-button>
                        <el-button
                            size="small"
                            :disabled="selectedCount === 0"
                            @click="clearSelection"
                        >
                            清除选择
                        </el-button>
                    </div>
                </div>

                <el-empty
                    v-if="items.length === 0 && !loading"
                    description="没有符合条件的记忆"
                    :image-size="64"
                />

                <div v-else class="memory-card-list">
                    <article
                        v-for="memory in items"
                        :key="memory.id"
                        :class="[
                            'memory-card',
                            `memory-card--${memory.type}`,
                            {
                                'is-archived': memory.status === 'archived',
                                'is-selected': isSelected(memory.id)
                            }
                        ]"
                    >
                        <div class="memory-card-main">
                            <div class="memory-card-header">
                                <div class="memory-card-title-block">
                                    <div class="memory-card-kicker">
                                        <el-checkbox
                                            :model-value="isSelected(memory.id)"
                                            class="memory-card-checkbox"
                                            @change="toggleSelected(memory.id)"
                                        />
                                        <span
                                            :class="[
                                                'type-text-span',
                                                getMemoryTagType(memory.type)
                                            ]"
                                        >
                                            {{
                                                getMemoryTypeLabel(memory.type)
                                            }}
                                        </span>
                                        <span
                                            :class="[
                                                'status-text-span',
                                                memory.status
                                            ]"
                                        >
                                            {{
                                                getMemoryStatusLabel(
                                                    memory.status
                                                )
                                            }}
                                        </span>
                                        <span
                                            v-if="memory.sentiment"
                                            class="memory-emotion"
                                        >
                                            {{ memory.sentiment }}
                                        </span>
                                        <span
                                            v-for="label in getMemorySpeakerLabels(memory)"
                                            :key="label"
                                            class="memory-speaker"
                                        >
                                            {{ label }}
                                        </span>
                                    </div>
                                    <p
                                        v-if="memory.summary"
                                        class="memory-card-summary"
                                    >
                                        {{ memory.summary }}
                                    </p>
                                </div>

                                <div class="memory-card-importance">
                                    <span class="memory-card-importance-label">
                                        重要度
                                    </span>
                                    <div
                                        class="importance-meter"
                                        :title="
                                            memory.importance == null
                                                ? '未设置重要度'
                                                : `重要度 ${formatImportance(memory.importance)}`
                                        "
                                    >
                                        <span
                                            :class="[
                                                'importance-meter-fill',
                                                getImportanceTone(
                                                    memory.importance
                                                )
                                            ]"
                                            :style="{
                                                width: formatImportancePercent(
                                                    memory.importance
                                                )
                                            }"
                                        />
                                    </div>
                                    <span class="memory-card-importance-value">
                                        {{
                                            formatImportance(
                                                memory.importance
                                            ) || '-'
                                        }}
                                    </span>
                                </div>
                            </div>

                            <p class="memory-card-content">
                                {{ memory.content }}
                            </p>

                            <div class="memory-card-footer">
                                <div class="memory-card-meta">
                                    <span>
                                        创建 {{ formatTime(memory.createdAt) }}
                                    </span>
                                    <span>
                                        更新 {{ formatTime(memory.updatedAt) }}
                                    </span>
                                </div>
                                <div
                                    v-if="memory.keywords.length > 0"
                                    class="memory-keywords"
                                >
                                    <el-tag
                                        v-for="keywordItem in memory.keywords"
                                        :key="keywordItem"
                                        size="small"
                                        effect="plain"
                                    >
                                        {{ keywordItem }}
                                    </el-tag>
                                </div>
                            </div>
                        </div>

                        <div class="memory-card-actions">
                            <el-button
                                size="small"
                                @click="emit('edit', memory)"
                            >
                                编辑
                            </el-button>
                            <el-button
                                size="small"
                                type="danger"
                                plain
                                @click="removeMemory(memory.id)"
                            >
                                删除
                            </el-button>
                        </div>
                    </article>
                </div>
            </div>

            <div class="pagination-container">
                <el-pagination
                    v-model:current-page="page"
                    v-model:page-size="pageSize"
                    :total="total"
                    :page-sizes="[20, 50, 100]"
                    layout="total, sizes, prev, pager, next, jumper"
                    @current-change="onPageChange"
                    @size-change="onPageSizeChange"
                />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as api from '../api'
import { useMemoryList } from '../composables/use-memory-list'
import { useSelection } from '../composables/use-selection'
import {
    memoryEntryTypes,
    type MemoryEntryRecord,
    type MemoryEntryType,
    type PresetSpeakerRecord
} from '../types'
import {
    formatImportance,
    formatImportancePercent,
    formatTime,
    getImportanceTone,
    getMemoryStatusLabel,
    getMemoryTagType,
    getMemoryTypeLabel,
    toErrorMessage
} from '../utils/display'

const props = defineProps<{
    presetId: string
}>()

const emit = defineEmits<{
    edit: [memory: MemoryEntryRecord]
    'total-change': [total: number]
}>()

const memoryTypes = memoryEntryTypes
const statusOptions = [
    { label: '活跃记忆', value: 'active' as const },
    { label: '归档记忆', value: 'archived' as const },
    { label: '全部记忆', value: 'all' as const }
]

const {
    items,
    page,
    pageSize,
    total,
    loading,
    keyword,
    memoryType,
    status,
    speakerKey,
    currentFilter,
    refresh: refreshList,
    changePage,
    changePageSize,
    clear,
    resetFilters,
    getStatusCount,
    getTypeCount
} = useMemoryList(toRef(props, 'presetId'))

const {
    selectedIds,
    selectedCount,
    isSelected,
    toggleSelected,
    selectAll,
    clearSelection
} = useSelection()

const selectAllPending = ref(false)
const batchDeleting = ref(false)
const speakers = ref<PresetSpeakerRecord[]>([])
const speakerLabelByKey = computed(
    () =>
        new Map(
            speakers.value.map((speaker) => [
                speaker.speakerKey,
                speaker.speakerLabel
            ])
        )
)

const isAllSelected = computed(
    () => total.value > 0 && selectedCount.value >= total.value
)
const isIndeterminate = computed(
    () => selectedCount.value > 0 && selectedCount.value < total.value
)

watch(
    () => props.presetId,
    () => {
        clearSelection()
        speakerKey.value = ''
        speakers.value = []
    }
)

const refresh = async (resetPage = false): Promise<boolean> => {
    if (props.presetId.length === 0) {
        clear()
        speakers.value = []
        emit('total-change', 0)
        return true
    }

    try {
        const [, presetSpeakers] = await Promise.all([
            refreshList(resetPage),
            api.listPresetSpeakers(props.presetId)
        ])
        speakers.value = presetSpeakers
        emit('total-change', total.value)
        return true
    } catch (error) {
        ElMessage.error(`获取记忆失败：${toErrorMessage(error)}`)
        return false
    }
}

const onFilterChange = async () => {
    clearSelection()
    await refresh(true)
}

const setStatus = async (value: 'active' | 'archived' | 'all') => {
    status.value = value
    await onFilterChange()
}

const setMemoryType = async (value: MemoryEntryType | '') => {
    memoryType.value = value
    await onFilterChange()
}

const getMemorySpeakerLabels = (memory: MemoryEntryRecord) => {
    if (memory.speakerKeys.length === 0) {
        return ['未关联用户']
    }
    return memory.speakerKeys.map(
        (key) => speakerLabelByKey.value.get(key) ?? '未知用户'
    )
}

const resetMemoryFilters = async () => {
    resetFilters()
    await onFilterChange()
}

const onPageChange = async (value: number) => {
    try {
        await changePage(value)
        emit('total-change', total.value)
    } catch (error) {
        ElMessage.error(`获取记忆失败：${toErrorMessage(error)}`)
    }
}

const onPageSizeChange = async (value: number) => {
    try {
        await changePageSize(value)
        emit('total-change', total.value)
    } catch (error) {
        ElMessage.error(`获取记忆失败：${toErrorMessage(error)}`)
    }
}

const removeMemory = async (memoryId: string) => {
    try {
        await ElMessageBox.confirm('删除后不可恢复，是否继续？', '危险操作', {
            type: 'warning',
            confirmButtonText: '确认删除',
            cancelButtonText: '取消'
        })
    } catch {
        return
    }

    try {
        await api.deleteMemory(memoryId)
        ElMessage.success('记忆已删除')
        if (items.value.length === 1 && page.value > 1) {
            page.value -= 1
        }
        await refresh()
    } catch (error) {
        ElMessage.error(`删除失败：${toErrorMessage(error)}`)
    }
}

const toggleSelectAll = async (checked: string | number | boolean) => {
    if (!checked) {
        clearSelection()
        return
    }

    selectAllPending.value = true
    try {
        const ids = await api.listMemoryIds(currentFilter.value)
        selectAll(ids)
    } catch (error) {
        ElMessage.error(`获取记忆失败：${toErrorMessage(error)}`)
    } finally {
        selectAllPending.value = false
    }
}

const removeSelectedMemories = async () => {
    const count = selectedCount.value
    try {
        await ElMessageBox.confirm(
            `将删除 ${count} 条记忆，删除后不可恢复，是否继续？`,
            '危险操作',
            {
                type: 'warning',
                confirmButtonText: '确认删除',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    batchDeleting.value = true
    try {
        const { deleted } = await api.deleteMemories(props.presetId, [
            ...selectedIds.value
        ])
        ElMessage.success(`已删除 ${deleted} 条记忆`)
        clearSelection()
        await refresh()
        if (items.value.length === 0 && page.value > 1 && total.value > 0) {
            page.value = Math.ceil(total.value / pageSize.value)
            await refresh()
        }
    } catch (error) {
        ElMessage.error(`批量删除失败：${toErrorMessage(error)}`)
    } finally {
        batchDeleting.value = false
    }
}

defineExpose({ refresh })
</script>

<style scoped src="../styles/memories.css"></style>
<style scoped src="../styles/tab-content.css"></style>
