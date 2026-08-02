<template>
    <k-layout
        :class="[
            'living-memory-dashboard',
            isDark ? 'lm-theme-dark' : 'lm-theme-light'
        ]"
    >
        <div class="dashboard-shell">
            <el-alert
                v-if="configWarnings.length > 0"
                class="config-warning-banner"
                type="warning"
                show-icon
                :closable="false"
            >
                <template #title>
                    检测到 {{ configWarnings.length }} 项配置告警
                </template>
                <ul class="config-warning-list">
                    <li v-for="warning in configWarnings" :key="warning.code">
                        <strong>{{ warning.field }}</strong>
                        ：{{ warning.message }}
                    </li>
                </ul>
            </el-alert>

            <el-card shadow="never" class="toolbar-card">
                <template #header>
                    <div class="toolbar-header">
                        <span class="toolbar-title">Living Memory</span>
                    </div>
                </template>

                <div class="toolbar-grid">
                    <div class="filter-group-horizontal">
                        <span class="field-label-inline">预设 ID</span>
                        <el-select
                            v-model="presetId"
                            filterable
                            allow-create
                            default-first-option
                            clearable
                            placeholder="选择或输入预设 ID"
                            class="preset-select"
                            :popper-class="
                                isDark
                                    ? 'lm-select-popper lm-theme-dark'
                                    : 'lm-select-popper lm-theme-light'
                            "
                            @change="onPresetChange"
                            @visible-change="onPresetVisibleChange"
                        >
                            <el-option
                                v-for="id in presetIds"
                                :key="id"
                                :label="id"
                                :value="id"
                            />
                        </el-select>
                    </div>

                    <div class="toolbar-actions">
                        <div class="refresh-btn-wrapper">
                            <el-button
                                :loading="loading"
                                type="primary"
                                class="refresh-button"
                                @click="manualRefresh"
                            >
                                刷新
                            </el-button>
                        </div>
                        <el-button
                            :disabled="!presetId"
                            @click="openCreateDialog"
                        >
                            注入记忆
                        </el-button>
                        <el-button
                            :disabled="!presetId"
                            :loading="dreamPending"
                            @click="runDreamJob"
                        >
                            执行 Dream
                        </el-button>
                        <el-dropdown
                            :disabled="!presetId"
                            @command="onPresetAction"
                        >
                            <el-button
                                :disabled="!presetId"
                                :loading="actionPending"
                            >
                                操作
                                <el-icon class="el-icon--right">
                                    <arrow-down />
                                </el-icon>
                            </el-button>
                            <template #dropdown>
                                <el-dropdown-menu>
                                    <el-dropdown-item
                                        command="export-preset"
                                    >
                                        导出记忆
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="import-preset"
                                    >
                                        导入记忆
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="rebuild-embeddings"
                                        divided
                                    >
                                        重建向量
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="clear-preset-data"
                                        divided
                                    >
                                        清空预设数据
                                    </el-dropdown-item>
                                </el-dropdown-menu>
                            </template>
                        </el-dropdown>
                    </div>
                </div>
            </el-card>

            <div class="dashboard-body-layout">
                <el-card
                    shadow="never"
                    class="main-content-card"
                    :body-style="{
                        display: 'flex',
                        flexDirection: 'column',
                        flex: 1,
                        minHeight: 0
                    }"
                >
                    <el-tabs v-model="activeTab" class="custom-tabs">
                        <el-tab-pane name="memories">
                            <template #label>
                                <span class="tab-label-container">
                                    <span>记忆列表</span>
                                    <span class="tab-badge">
                                        {{ memoryTotal }}
                                    </span>
                                </span>
                            </template>
                            <memories-tab
                                ref="memoriesTab"
                                :preset-id="presetId"
                                @edit="openEditDialog"
                                @total-change="memoryTotal = $event"
                            />
                        </el-tab-pane>

                        <el-tab-pane name="profiles">
                            <template #label>
                                <span class="tab-label-container">
                                    <span>用户画像</span>
                                    <span class="tab-badge">
                                        {{ profileTotal }}
                                    </span>
                                </span>
                            </template>
                            <profiles-tab
                                ref="profilesTab"
                                :preset-id="presetId"
                                @total-change="profileTotal = $event"
                            />
                        </el-tab-pane>

                        <el-tab-pane name="snapshots">
                            <template #label>
                                <span class="tab-label-container">
                                    <span>快照列表</span>
                                    <span class="tab-badge">
                                        {{ snapshotTotal }}
                                    </span>
                                </span>
                            </template>
                            <snapshots-tab
                                ref="snapshotsTab"
                                :preset-id="presetId"
                                :is-dark="isDark"
                                @total-change="snapshotTotal = $event"
                            />
                        </el-tab-pane>

                        <el-tab-pane name="jobs">
                            <template #label>
                                <span class="tab-label-container">
                                    <span>任务列表</span>
                                    <span class="tab-badge">
                                        {{ jobTotal }}
                                    </span>
                                </span>
                            </template>
                            <jobs-tab
                                ref="jobsTab"
                                :preset-id="presetId"
                                @total-change="jobTotal = $event"
                            />
                        </el-tab-pane>
                    </el-tabs>
                </el-card>
            </div>
        </div>
    </k-layout>

    <input
        ref="importFileInput"
        type="file"
        accept=".json,application/json"
        style="display: none"
        @change="onImportFileSelected"
    />

    <memory-editor-dialog
        v-model="memoryDialogVisible"
        :preset-id="presetId"
        :memory="editingMemory"
        :is-dark="isDark"
        @saved="onMemorySaved"
    />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useColorMode } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import * as api from './api'
import JobsTab from './components/jobs-tab.vue'
import MemoriesTab from './components/memories-tab.vue'
import MemoryEditorDialog from './components/memory-editor-dialog.vue'
import ProfilesTab from './components/profiles-tab.vue'
import SnapshotsTab from './components/snapshots-tab.vue'
import type {
    LivingMemoryPresetExport,
    MemoryConfigWarning,
    MemoryEntryRecord
} from './types'

type DashboardTab = 'memories' | 'profiles' | 'snapshots' | 'jobs'

interface RefreshableTab {
    refresh(resetPage?: boolean): Promise<boolean>
}

const loading = ref(false)
const dreamPending = ref(false)
const actionPending = ref(false)
const memoryDialogVisible = ref(false)
const editingMemory = ref<MemoryEntryRecord | null>(null)
const importFileInput = ref<HTMLInputElement | null>(null)

const presetId = ref('')
const presetIds = ref<string[]>([])
const configWarnings = ref<MemoryConfigWarning[]>([])
const activeTab = ref<DashboardTab>('memories')

const memoryTotal = ref(0)
const profileTotal = ref(0)
const snapshotTotal = ref(0)
const jobTotal = ref(0)

const memoriesTab = ref<RefreshableTab | null>(null)
const profilesTab = ref<RefreshableTab | null>(null)
const snapshotsTab = ref<RefreshableTab | null>(null)
const jobsTab = ref<RefreshableTab | null>(null)

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const normalizePreset = () => {
    presetId.value = presetId.value.trim()
}

const ensurePreset = () => {
    normalizePreset()
    if (presetId.value.length > 0) {
        return true
    }
    ElMessage.warning('请先输入预设 ID')
    return false
}

const fetchConfigStatus = async () => {
    try {
        const status = await api.getStatus()
        configWarnings.value = status.warnings ?? []
    } catch {
        configWarnings.value = []
    }
}

const fetchPresetIds = async () => {
    try {
        presetIds.value = await api.listPresetIds()
    } catch {
        // 静默失败，用户仍可手动输入
    }
}

const refreshTabs = async (
    tabs: Array<RefreshableTab | null>,
    resetPage = false
) => {
    await Promise.all(tabs.map((tab) => tab?.refresh(resetPage)))
}

const refreshAll = async (resetPage = false) => {
    normalizePreset()
    loading.value = true
    try {
        await refreshTabs(
            [
                memoriesTab.value,
                profilesTab.value,
                snapshotsTab.value,
                jobsTab.value
            ],
            resetPage
        )
    } finally {
        loading.value = false
    }
}

const refreshActiveTab = async () => {
    if (presetId.value.length === 0) return
    const tabs: Record<DashboardTab, RefreshableTab | null> = {
        memories: memoriesTab.value,
        profiles: profilesTab.value,
        snapshots: snapshotsTab.value,
        jobs: jobsTab.value
    }
    await tabs[activeTab.value]?.refresh()
}

const manualRefresh = async () => {
    if (!ensurePreset()) return
    await refreshAll(true)
}

const onPresetChange = async () => {
    normalizePreset()
    await nextTick()
    await refreshAll(true)
}

const onPresetVisibleChange = (visible: boolean) => {
    if (visible) {
        fetchPresetIds()
    }
}

const openCreateDialog = () => {
    if (!ensurePreset()) return
    editingMemory.value = null
    memoryDialogVisible.value = true
}

const openEditDialog = (memory: MemoryEntryRecord) => {
    editingMemory.value = memory
    memoryDialogVisible.value = true
}

const onMemorySaved = async () => {
    await memoriesTab.value?.refresh(true)
}

const runDreamJob = async () => {
    if (!ensurePreset()) return
    dreamPending.value = true

    try {
        const result = await api.runDream(presetId.value)
        if (result.started) {
            ElMessage.success('Dream 任务已触发')
        } else if (result.reason === 'preset-locked') {
            ElMessage.info('Dream 任务正在运行')
        }
        await refreshTabs(
            [memoriesTab.value, profilesTab.value, jobsTab.value],
            true
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`Dream 触发失败：${message}`)
    } finally {
        dreamPending.value = false
    }
}

const doRebuildEmbeddings = async () => {
    try {
        await ElMessageBox.confirm(
            '确认重建全部嵌入向量？此操作会消耗 embedding API 调用。',
            '重建向量',
            {
                type: 'warning',
                confirmButtonText: '确认重建',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    try {
        const result = await api.rebuildEmbeddings(presetId.value)
        ElMessage.success(`已重建 ${result.rebuilt} 条记忆的嵌入向量`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`重建向量失败：${message}`)
    }
}

const doClearPresetData = async () => {
    try {
        await ElMessageBox.confirm(
            `该操作会清空预设 ${presetId.value} 的全部记忆、用户画像、快照和任务记录，且不可恢复。是否继续？`,
            '危险操作',
            {
                type: 'warning',
                confirmButtonText: '确认清空',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    try {
        await api.clearPresetData(presetId.value)
        ElMessage.success('该预设的数据已清空')
        await refreshAll(true)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`清空失败：${message}`)
    }
}

const formatExportFilename = (presetId: string) => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds())
    ].join('')
    return `livingmemory-${presetId}-${stamp}.json`
}

const doExportPreset = async () => {
    try {
        const data = await api.exportPreset(presetId.value)
        const blob = new Blob([JSON.stringify(data, null, 2)], {
            type: 'application/json'
        })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = formatExportFilename(presetId.value)
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
        ElMessage.success(
            `已导出 ${data.entries.length} 条记忆、${data.userProfiles.length} 个用户画像、${data.presetSpeakers.length} 个说话者`
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`导出失败：${message}`)
    }
}

const triggerImportFile = () => {
    importFileInput.value?.click()
}

const onImportFileSelected = async (event: Event) => {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (file == null) return
    input.value = ''

    let data: LivingMemoryPresetExport
    try {
        const text = await file.text()
        data = JSON.parse(text) as LivingMemoryPresetExport
    } catch {
        ElMessage.error('无法解析文件，请选择有效的 JSON 文件')
        return
    }

    if (data.version !== 1) {
        ElMessage.error(`不支持的导出版本：${data.version}`)
        return
    }

    try {
        await ElMessageBox.confirm(
            `将导入 ${data.entries.length} 条记忆、${data.userProfiles.length} 个用户画像、${data.presetSpeakers.length} 个说话者到预设 ${presetId.value}。相同 ID 的记录将被覆盖，导入后需要重建向量。是否继续？`,
            '导入记忆',
            {
                type: 'warning',
                confirmButtonText: '确认导入',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    try {
        const result = await api.importPreset(presetId.value, data)
        ElMessage.success(
            `已导入 ${result.entries} 条记忆、${result.userProfiles} 个用户画像、${result.presetSpeakers} 个说话者`
        )
        await refreshAll(true)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`导入失败：${message}`)
    }
}

const onPresetAction = async (command: string) => {
    if (!ensurePreset()) return
    actionPending.value = true
    try {
        if (command === 'export-preset') {
            await doExportPreset()
        } else if (command === 'import-preset') {
            triggerImportFile()
        } else if (command === 'rebuild-embeddings') {
            await doRebuildEmbeddings()
        } else if (command === 'clear-preset-data') {
            await doClearPresetData()
        }
    } finally {
        actionPending.value = false
    }
}

watch(activeTab, () => {
    void refreshActiveTab()
})

onMounted(() => {
    fetchPresetIds()
    fetchConfigStatus()
})
</script>

<style scoped src="./styles/dashboard.css"></style>
