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
                prop="strategy"
                label="策略"
                width="140"
                align="center"
                header-align="center"
            />
            <el-table-column
                prop="query"
                label="查询"
                min-width="180"
                header-align="center"
                show-overflow-tooltip
            />
            <el-table-column
                label="命中"
                width="80"
                align="center"
                header-align="center"
            >
                <template #default="scope">
                    {{ snapshotHitCount(scope.row) }}
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
                label="操作"
                width="180"
                align="center"
                header-align="center"
                fixed="right"
            >
                <template #default="scope">
                    <el-space>
                        <el-button
                            size="small"
                            @click="openSnapshotDialog(scope.row)"
                        >
                            详情
                        </el-button>
                        <el-button
                            size="small"
                            type="danger"
                            plain
                            :loading="deletingSnapshotId === scope.row.id"
                            @click="removeSnapshot(scope.row)"
                        >
                            删除
                        </el-button>
                    </el-space>
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

    <snapshot-detail-dialog
        v-model="snapshotDialogVisible"
        :snapshot="selectedSnapshot"
        :is-dark="isDark"
    />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as api from '../api'
import { usePagedResource } from '../composables/use-paged-resource'
import type { MemorySnapshotRecord } from '../types'
import { formatTime, snapshotHitCount } from '../utils/display'
import SnapshotDetailDialog from './snapshot-detail-dialog.vue'

const props = defineProps<{
    presetId: string
    isDark: boolean
}>()

const emit = defineEmits<{
    'total-change': [total: number]
}>()

const snapshotDialogVisible = ref(false)
const selectedSnapshot = ref<MemorySnapshotRecord | null>(null)
const deletingSnapshotId = ref<string | null>(null)
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
} = usePagedResource<MemorySnapshotRecord>(async (pageValue, pageSizeValue) => {
    return await api.listSnapshots({
        presetId: props.presetId,
        page: pageValue,
        pageSize: pageSizeValue
    })
})

const refresh = async (resetPage = false): Promise<boolean> => {
    if (props.presetId.length === 0) {
        clear()
        selectedSnapshot.value = null
        snapshotDialogVisible.value = false
        emit('total-change', 0)
        return true
    }

    try {
        await refreshPage(resetPage)
        emit('total-change', total.value)
        return true
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取快照失败：${message}`)
        return false
    }
}

const onPageChange = async (value: number) => {
    try {
        await changePage(value)
        emit('total-change', total.value)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取快照失败：${message}`)
    }
}

const onPageSizeChange = async (value: number) => {
    try {
        await changePageSize(value)
        emit('total-change', total.value)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取快照失败：${message}`)
    }
}

const openSnapshotDialog = (snapshot: MemorySnapshotRecord) => {
    selectedSnapshot.value = snapshot
    snapshotDialogVisible.value = true
}

const removeSnapshot = async (snapshot: MemorySnapshotRecord) => {
    try {
        await ElMessageBox.confirm(
            '删除该会话快照后，该会话下一轮将不会注入这次召回结果；新的召回会重新生成快照。是否继续？',
            '删除快照',
            {
                type: 'warning',
                confirmButtonText: '确认删除',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    deletingSnapshotId.value = snapshot.id
    try {
        await api.deleteSnapshot(snapshot.id)
        if (selectedSnapshot.value?.id === snapshot.id) {
            snapshotDialogVisible.value = false
            selectedSnapshot.value = null
        }
        ElMessage.success('快照已删除')
        if (items.value.length === 1 && page.value > 1) {
            page.value -= 1
        }
        await refresh()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`删除失败：${message}`)
    } finally {
        deletingSnapshotId.value = null
    }
}

defineExpose({ refresh })
</script>

<style scoped src="../styles/tab-content.css"></style>
