<template>
    <div class="tab-pane-content">
        <el-table :data="items" border v-loading="loading">
            <el-table-column
                prop="id"
                label="ID"
                min-width="160"
                header-align="center"
            />
            <el-table-column
                label="类型"
                width="120"
                align="center"
                header-align="center"
            >
                <template #default="scope">
                    {{ getJobKindLabel(scope.row.kind) }}
                </template>
            </el-table-column>
            <el-table-column
                label="召回策略"
                width="150"
                align="center"
                header-align="center"
            >
                <template #default="scope">
                    {{ formatJobRecallStrategy(scope.row.recallStrategy) }}
                </template>
            </el-table-column>
            <el-table-column
                label="状态"
                width="120"
                align="center"
                header-align="center"
            >
                <template #default="scope">
                    <el-tag
                        :type="getJobStatusTagType(scope.row.status)"
                        size="small"
                        effect="light"
                    >
                        {{ getJobStatusLabel(scope.row.status) }}
                    </el-tag>
                </template>
            </el-table-column>
            <el-table-column
                label="创建时间"
                min-width="160"
                align="center"
                header-align="center"
            >
                <template #default="scope">
                    {{ formatTime(scope.row.createdAt) }}
                </template>
            </el-table-column>
            <el-table-column
                label="更新时间"
                min-width="160"
                align="center"
                header-align="center"
            >
                <template #default="scope">
                    {{ formatTime(scope.row.updatedAt) }}
                </template>
            </el-table-column>
        </el-table>

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
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'
import * as api from '../api'
import { usePagedResource } from '../composables/use-paged-resource'
import type { MemoryJobRecord } from '../types'
import {
    formatJobRecallStrategy,
    formatTime,
    getJobKindLabel,
    getJobStatusLabel,
    getJobStatusTagType
} from '../utils/display'

const props = defineProps<{
    presetId: string
}>()

const emit = defineEmits<{
    'total-change': [total: number]
}>()

const {
    items,
    page,
    pageSize,
    total,
    loading,
    refresh: refreshPage,
    changePage,
    changePageSize,
    clear
} = usePagedResource<MemoryJobRecord>(async (pageValue, pageSizeValue) => {
    return await api.listJobs({
        presetId: props.presetId,
        page: pageValue,
        pageSize: pageSizeValue
    })
})

const refresh = async (resetPage = false): Promise<boolean> => {
    if (props.presetId.length === 0) {
        clear()
        emit('total-change', 0)
        return true
    }

    try {
        await refreshPage(resetPage)
        emit('total-change', total.value)
        return true
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取任务失败：${message}`)
        return false
    }
}

const onPageChange = async (value: number) => {
    try {
        await changePage(value)
        emit('total-change', total.value)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取任务失败：${message}`)
    }
}

const onPageSizeChange = async (value: number) => {
    try {
        await changePageSize(value)
        emit('total-change', total.value)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取任务失败：${message}`)
    }
}

defineExpose({ refresh })
</script>

<style scoped src="../styles/tab-content.css"></style>
