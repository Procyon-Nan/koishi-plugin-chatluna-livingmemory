<template>
    <div class="tab-pane-content">
        <div class="profile-list-panel" v-loading="loading">
            <el-empty
                v-if="items.length === 0 && !loading"
                description="暂无用户画像"
                :image-size="64"
            />

            <div v-else class="profile-card-list">
                <article
                    v-for="profile in items"
                    :key="profile.id"
                    class="profile-card"
                >
                    <div class="profile-card-header">
                        <div class="profile-card-title-block">
                            <div class="profile-card-kicker">用户画像</div>
                            <h3 class="profile-card-title">
                                {{ profile.speakerLabel }}
                            </h3>
                        </div>
                        <span class="profile-source-count">
                            {{
                                profile.sourceMemoryIds?.length ?? 0
                            }}
                            条来源记忆
                        </span>
                    </div>

                    <p class="profile-card-content">
                        {{ profile.content }}
                    </p>

                    <div class="profile-card-footer">
                        <div class="profile-card-meta">
                            <span>
                                创建 {{ formatTime(profile.createdAt) }}
                            </span>
                            <span>
                                更新 {{ formatTime(profile.updatedAt) }}
                            </span>
                        </div>
                        <div class="profile-card-actions">
                            <el-button
                                size="small"
                                plain
                                :loading="editingProfileId === profile.id"
                                @click="editUserProfile(profile)"
                            >
                                编辑
                            </el-button>
                            <el-button
                                size="small"
                                type="danger"
                                plain
                                :loading="deletingProfileId === profile.id"
                                @click="removeUserProfile(profile)"
                            >
                                删除
                            </el-button>
                        </div>
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
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as api from '../api'
import { usePagedResource } from '../composables/use-paged-resource'
import type { UserProfileRecord } from '../types'
import { formatTime } from '../utils/display'

const props = defineProps<{
    presetId: string
}>()

const emit = defineEmits<{
    'total-change': [total: number]
}>()

const deletingProfileId = ref<string | null>(null)
const editingProfileId = ref<string | null>(null)
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
} = usePagedResource<UserProfileRecord>(async (pageValue, pageSizeValue) => {
    return await api.listUserProfiles({
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
        ElMessage.error(`获取用户画像失败：${message}`)
        return false
    }
}

const onPageChange = async (value: number) => {
    try {
        await changePage(value)
        emit('total-change', total.value)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取用户画像失败：${message}`)
    }
}

const onPageSizeChange = async (value: number) => {
    try {
        await changePageSize(value)
        emit('total-change', total.value)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取用户画像失败：${message}`)
    }
}

const removeUserProfile = async (profile: UserProfileRecord) => {
    try {
        await ElMessageBox.confirm(
            `删除 ${profile.speakerLabel} 的用户画像后，该画像将不再注入；后续 Dream 仍可能根据记忆重新生成。是否继续？`,
            '删除用户画像',
            {
                type: 'warning',
                confirmButtonText: '确认删除',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    deletingProfileId.value = profile.id
    try {
        await api.deleteUserProfile(profile.id)
        ElMessage.success('用户画像已删除')
        if (items.value.length === 1 && page.value > 1) {
            page.value -= 1
        }
        await refresh()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`删除失败：${message}`)
    } finally {
        deletingProfileId.value = null
    }
}

const editUserProfile = async (profile: UserProfileRecord) => {
    let content: string
    try {
        const result = await ElMessageBox.prompt(
            '保存后的内容仍可能被后续 Dream 自动更新覆盖。',
            `编辑 ${profile.speakerLabel} 的用户画像`,
            {
                inputType: 'textarea',
                inputValue: profile.content,
                inputPlaceholder: '请输入 1-220 个字符',
                confirmButtonText: '保存',
                cancelButtonText: '取消',
                inputValidator: (value) => {
                    const length = Array.from(value.trim()).length
                    return length >= 1 && length <= 220
                        ? true
                        : '用户画像正文长度必须为 1-220 个字符'
                }
            }
        )
        content = result.value.trim()
    } catch {
        return
    }

    editingProfileId.value = profile.id
    try {
        await api.updateUserProfile(profile.id, content)
        ElMessage.success('用户画像已更新')
        await refresh()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`更新失败：${message}`)
    } finally {
        editingProfileId.value = null
    }
}

defineExpose({ refresh })
</script>

<style scoped src="../styles/profiles.css"></style>
<style scoped src="../styles/tab-content.css"></style>
