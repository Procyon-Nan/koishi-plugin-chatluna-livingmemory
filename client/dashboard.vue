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

            <el-card shadow="never" class="vector-status-card">
                <div class="vector-status-grid">
                    <div class="vector-status-item">
                        <span class="vector-status-label">全局索引</span>
                        <span
                            :class="[
                                'vector-status-state',
                                `is-${globalVectorState}`
                            ]"
                        >
                            {{ getVectorStateLabel(globalVectorState) }}
                        </span>
                    </div>
                    <div class="vector-status-item">
                        <span class="vector-status-label">当前预设</span>
                        <span
                            :class="[
                                'vector-status-state',
                                `is-${currentPresetVectorState}`
                            ]"
                        >
                            {{ currentPresetVectorLabel }}
                        </span>
                    </div>
                    <div class="vector-status-item">
                        <span class="vector-status-label">索引数量</span>
                        <span class="vector-status-value">
                            {{ currentPresetVectorCount }}
                        </span>
                    </div>
                    <div class="vector-status-item">
                        <span class="vector-status-label">当前任务</span>
                        <span class="vector-status-value">
                            {{ currentVectorJobId }}
                        </span>
                    </div>
                </div>
                <el-alert
                    v-if="vectorIndexError !== null"
                    class="vector-status-error"
                    type="error"
                    :closable="false"
                    show-icon
                    :title="vectorIndexError"
                />
            </el-card>

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
                        <el-button
                            :loading="loading"
                            @click="manualRefresh"
                        >
                            刷新
                        </el-button>
                        <el-button
                            :disabled="!presetId"
                            @click="openCreateDialog"
                        >
                            注入记忆
                        </el-button>
                        <el-button
                            :disabled="!presetId || !vectorWorkflowReady"
                            :loading="dreamPending"
                            @click="runDreamJob"
                        >
                            执行 Dream
                        </el-button>
                        <el-dropdown
                            :disabled="actionPending"
                            @command="onPresetAction"
                        >
                            <el-button
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
                                        :disabled="!presetId"
                                    >
                                        导出记忆
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="import-preset"
                                        :disabled="!presetId"
                                    >
                                        导入记忆
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="reconcile-vector-index"
                                        :disabled="
                                            !presetId ||
                                            currentPresetVectorState === 'building'
                                        "
                                        divided
                                    >
                                        修复当前预设索引
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="rebuild-vector-index"
                                        :disabled="globalVectorState === 'building'"
                                    >
                                        全量重建索引
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="restart-vector-index"
                                    >
                                        重启索引 Worker
                                    </el-dropdown-item>
                                    <el-dropdown-item
                                        command="clear-preset-data"
                                        :disabled="!presetId"
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
                                :is-dark="isDark"
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

                        <el-tab-pane
                            name="search-test"
                            :disabled="!vectorWorkflowReady"
                        >
                            <template #label>
                                <span class="tab-label-container">
                                    <span>召回测试</span>
                                </span>
                            </template>
                            <search-test-tab
                                :preset-id="presetId"
                                :disabled="!vectorWorkflowReady"
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
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch
} from 'vue'
import { useColorMode } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import * as api from './api'
import JobsTab from './components/jobs-tab.vue'
import MemoriesTab from './components/memories-tab.vue'
import MemoryEditorDialog from './components/memory-editor-dialog.vue'
import ProfilesTab from './components/profiles-tab.vue'
import SearchTestTab from './components/search-test-tab.vue'
import SnapshotsTab from './components/snapshots-tab.vue'
import { isVectorWorkflowReady } from './utils/vector-index'
import { toErrorMessage } from './utils/display'
import type {
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    MemoryConfigWarning,
    MemoryEntryRecord,
    MemoryVectorIndexState,
    MemoryVectorIndexStatus
} from './types'

type DashboardTab = 'memories' | 'profiles' | 'snapshots' | 'jobs' | 'search-test'

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
const vectorIndexStatus = ref<MemoryVectorIndexStatus | null>(null)
const importedPresetAwaitingIndex = ref('')
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

const currentPresetVectorStatus = computed(() => {
    const status = vectorIndexStatus.value
    if (status === null) {
        return undefined
    }
    return status.presets.find((item) => item.presetId === presetId.value)
})

const globalVectorState = computed<MemoryVectorIndexState>(() => {
    if (vectorIndexStatus.value === null) {
        return 'unavailable'
    }
    return vectorIndexStatus.value.state
})

const currentPresetVectorState = computed<MemoryVectorIndexState>(() => {
    if (globalVectorState.value !== 'ready') {
        return globalVectorState.value
    }
    const preset = currentPresetVectorStatus.value
    if (preset !== undefined) {
        return preset.state
    }
    return globalVectorState.value
})

const currentPresetVectorLabel = computed(() => {
    if (presetId.value.length === 0) {
        return '未选择'
    }
    return getVectorStateLabel(currentPresetVectorState.value)
})

const currentPresetVectorCount = computed(() => {
    const preset = currentPresetVectorStatus.value
    if (preset === undefined) {
        return '0 / 0'
    }
    return `${preset.indexedCount} / ${preset.expectedCount}`
})

const currentVectorJobId = computed(() => {
    const jobId = vectorIndexStatus.value?.currentJobId
    if (jobId === null || jobId === undefined) {
        return '无'
    }
    return jobId
})

const vectorIndexError = computed(() => {
    const presetError = currentPresetVectorStatus.value?.lastError
    if (presetError !== null && presetError !== undefined) {
        return presetError
    }
    return vectorIndexStatus.value?.lastError ?? null
})

const vectorWorkflowReady = computed(() => {
    return isVectorWorkflowReady(vectorIndexStatus.value, presetId.value)
})

const getVectorStateLabel = (state: MemoryVectorIndexState) => {
    switch (state) {
        case 'ready':
            return '就绪'
        case 'building':
            return '同步中'
        case 'dirty':
            return '需要修复'
        case 'unavailable':
            return '不可用'
    }
}

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

const confirmAndRun = async (options: {
    confirmMessage: string
    confirmTitle: string
    confirmButtonText: string
    action: () => Promise<string>
    failurePrefix: string
    refresh?: () => Promise<unknown>
}) => {
    try {
        await ElMessageBox.confirm(
            options.confirmMessage,
            options.confirmTitle,
            {
                type: 'warning',
                confirmButtonText: options.confirmButtonText,
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    try {
        ElMessage.success(await options.action())
        if (options.refresh != null) {
            await options.refresh()
        }
    } catch (error) {
        ElMessage.error(`${options.failurePrefix}${toErrorMessage(error)}`)
    }
}

const fetchConfigStatus = async () => {
    try {
        const status = await api.getStatus()
        configWarnings.value = status.warnings
        vectorIndexStatus.value = status.vectorIndex
        if (
            importedPresetAwaitingIndex.value.length > 0 &&
            isVectorWorkflowReady(
                status.vectorIndex,
                importedPresetAwaitingIndex.value
            )
        ) {
            ElMessage.success('导入记忆的索引同步已完成，请执行手动 Dream')
            importedPresetAwaitingIndex.value = ''
        }
    } catch {
        configWarnings.value = []
        vectorIndexStatus.value = null
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
        await Promise.all([
            refreshTabs(
                [
                    memoriesTab.value,
                    profilesTab.value,
                    snapshotsTab.value,
                    jobsTab.value
                ],
                resetPage
            ),
            fetchConfigStatus()
        ])
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
        await fetchConfigStatus()
    } catch (error) {
        ElMessage.error(`Dream 触发失败：${toErrorMessage(error)}`)
    } finally {
        dreamPending.value = false
    }
}

const doReconcileVectorIndex = () =>
    confirmAndRun({
        confirmMessage: `确认重新同步预设 ${presetId.value} 的向量索引？`,
        confirmTitle: '修复当前预设索引',
        confirmButtonText: '确认同步',
        failurePrefix: '索引同步失败：',
        action: async () => {
            const job = await api.reconcileVectorIndex(presetId.value)
            return `索引同步任务已创建：${job.id}`
        },
        refresh: async () => {
            await Promise.all([
                fetchConfigStatus(),
                jobsTab.value?.refresh(true)
            ])
        }
    })

const doRebuildVectorIndex = () =>
    confirmAndRun({
        confirmMessage: '确认全量重建向量索引？重建期间 Dream 与召回测试不可用。',
        confirmTitle: '全量重建索引',
        confirmButtonText: '确认重建',
        failurePrefix: '启动索引重建失败：',
        action: async () => {
            await api.rebuildVectorIndex()
            return '全量索引重建任务已启动'
        },
        refresh: fetchConfigStatus
    })

const doRestartVectorIndex = () =>
    confirmAndRun({
        confirmMessage: '确认重启向量索引 Worker？重启后会自动检查并同步索引。',
        confirmTitle: '重启索引 Worker',
        confirmButtonText: '确认重启',
        failurePrefix: '重启索引 Worker 失败：',
        action: async () => {
            await api.restartVectorIndex()
            return '向量索引 Worker 已重启，正在检查索引'
        },
        refresh: fetchConfigStatus
    })

const doClearPresetData = () =>
    confirmAndRun({
        confirmMessage: `该操作会清空预设 ${presetId.value} 的全部记忆、用户画像、快照和任务记录，且不可恢复。是否继续？`,
        confirmTitle: '危险操作',
        confirmButtonText: '确认清空',
        failurePrefix: '清空失败：',
        action: async () => {
            await api.clearPresetData(presetId.value)
            return '该预设的数据已清空'
        },
        refresh: () => refreshAll(true)
    })

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
        ElMessage.error(`导出失败：${toErrorMessage(error)}`)
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

    if (data.version !== 1 && data.version !== 2) {
        ElMessage.error(`不支持的导出版本：${data.version}`)
        return
    }

    try {
        await ElMessageBox.confirm(
            `将导入 ${data.entries.length} 条记忆、${data.userProfiles.length} 个用户画像、${data.presetSpeakers.length} 个说话者到预设 ${presetId.value}。相同 ID 的记录将被覆盖。是否继续？`,
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

    let result: LivingMemoryPresetImportResult
    try {
        result = await api.importPreset(presetId.value, data)
        ElMessage.success(
            `已导入 ${result.entries} 条记忆、${result.userProfiles} 个用户画像、${result.presetSpeakers} 个说话者`
        )
        await refreshAll(true)
    } catch (error) {
        ElMessage.error(`导入失败：${toErrorMessage(error)}`)
        return
    }

    await ElMessageBox.alert(
        `关系数据已导入，索引同步任务 ${result.indexJobId} 已创建。索引状态变为“就绪”后，请执行一次手动 Dream。`,
        '索引同步中',
        {
            type: 'info',
            confirmButtonText: '知道了',
            showClose: false,
            closeOnClickModal: false,
            closeOnPressEscape: false
        }
    )
    importedPresetAwaitingIndex.value = presetId.value
    await fetchConfigStatus()
}

const onPresetAction = async (command: string) => {
    actionPending.value = true
    try {
        if (command === 'export-preset') {
            if (!ensurePreset()) return
            await doExportPreset()
        } else if (command === 'import-preset') {
            if (!ensurePreset()) return
            triggerImportFile()
        } else if (command === 'reconcile-vector-index') {
            if (!ensurePreset()) return
            await doReconcileVectorIndex()
        } else if (command === 'rebuild-vector-index') {
            await doRebuildVectorIndex()
        } else if (command === 'restart-vector-index') {
            await doRestartVectorIndex()
        } else if (command === 'clear-preset-data') {
            if (!ensurePreset()) return
            await doClearPresetData()
        }
    } finally {
        actionPending.value = false
    }
}

watch(activeTab, () => {
    void refreshActiveTab()
})

let statusRefreshTimer = 0

onMounted(() => {
    fetchPresetIds()
    fetchConfigStatus()
    statusRefreshTimer = window.setInterval(fetchConfigStatus, 5_000)
})

onBeforeUnmount(() => {
    window.clearInterval(statusRefreshTimer)
})
</script>

<style scoped src="./styles/dashboard.css"></style>

<style>
/* Themed scrollbars — non-scoped so pseudo-elements reach child components */
.living-memory-dashboard,
.living-memory-dashboard * {
    scrollbar-width: thin;
    scrollbar-color: var(--lm-border-hover) transparent;
}

.living-memory-dashboard::-webkit-scrollbar,
.living-memory-dashboard *::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

.living-memory-dashboard::-webkit-scrollbar-track,
.living-memory-dashboard *::-webkit-scrollbar-track {
    background: transparent;
}

.living-memory-dashboard::-webkit-scrollbar-thumb,
.living-memory-dashboard *::-webkit-scrollbar-thumb {
    background-color: var(--lm-border-hover);
    border-radius: 3px;
}

.living-memory-dashboard::-webkit-scrollbar-thumb:hover,
.living-memory-dashboard *::-webkit-scrollbar-thumb:hover {
    background-color: var(--lm-text-tertiary);
}
</style>
