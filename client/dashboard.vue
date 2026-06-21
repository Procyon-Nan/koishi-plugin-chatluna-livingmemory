<template>
    <k-layout :class="['living-memory-dashboard', isDark ? 'lm-theme-dark' : 'lm-theme-light']">
        <div class="dashboard-shell">
            <!-- Alert banner -->
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
                        <strong>{{ warning.field }}</strong>：{{ warning.message }}
                    </li>
                </ul>
            </el-alert>

            <!-- Toolbar Card -->
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
                            :popper-class="isDark ? 'lm-select-popper lm-theme-dark' : 'lm-select-popper lm-theme-light'"
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
                            <el-button :loading="loading" type="primary" @click="refreshAll" class="refresh-button">
                                刷新
                            </el-button>
                        </div>
                        <el-button :disabled="!presetId" @click="openCreateDialog">
                            注入记忆
                        </el-button>
                        <el-button
                            :disabled="!presetId"
                            :loading="dreamPending"
                            @click="runDreamJob"
                        >
                            执行 Dream
                        </el-button>
                        <el-button
                            :disabled="!presetId"
                            :loading="clearPending"
                            type="danger"
                            plain
                            @click="doClearPresetData"
                        >
                            清空预设数据
                        </el-button>
                    </div>
                </div>
            </el-card>

            <!-- Two Column Layout: Filter left, List right -->
            <div class="dashboard-body-layout">
                <!-- Memory Category Filtering Card (Vertical Left) -->
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
                                v-model="memoryKeyword"
                                placeholder="输入并回车搜索"
                                clearable
                                class="keyword-input"
                                @keyup.enter="onMemoryFilterChange"
                                @clear="onMemoryFilterChange"
                            />
                        </div>
                        <div class="category-item-vertical">
                            <span class="category-label-vertical">状态</span>
                            <div class="category-options-vertical">
                                <button 
                                    v-for="opt in statusOptions" 
                                    :key="opt.value"
                                    :class="['category-btn-vertical', { active: memoryStatus === opt.value }]"
                                    @click="setMemoryStatus(opt.value)"
                                >
                                    <span class="btn-text-content">{{ opt.label }}</span>
                                    <span class="btn-count-badge">{{ getStatusCount(opt.value) }}</span>
                                </button>
                            </div>
                        </div>
                        <div class="category-item-vertical">
                            <span class="category-label-vertical">类别</span>
                            <div class="category-options-vertical">
                                <button 
                                    :class="['category-btn-vertical', { active: memoryType === '' }]"
                                    @click="setMemoryType('')"
                                >
                                    <span class="btn-text-content">全部</span>
                                    <span class="btn-count-badge">{{ totalMemoryCount }}</span>
                                </button>
                                <button 
                                    v-for="type in memoryTypes" 
                                    :key="type"
                                    :class="['category-btn-vertical', { active: memoryType === type }]"
                                    @click="setMemoryType(type)"
                                >
                                    <span class="btn-text-content">{{ getMemoryTypeLabel(type) }}</span>
                                    <span class="btn-count-badge">{{ getTypeCount(type) }}</span>
                                </button>
                            </div>
                        </div>
                        <!-- Reset Button -->
                        <div class="category-reset-container">
                            <button class="reset-filter-btn" @click="resetFilters">
                                重置筛选条件
                            </button>
                        </div>
                    </div>
                </el-card>

                <!-- Consolidated Main Content Tabs Card (Right) -->
                <el-card shadow="never" class="main-content-card" :body-style="{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }">
                    <el-tabs v-model="activeTab" class="custom-tabs">
                        <el-tab-pane name="memories">
                            <template #label>
                                <span class="tab-label-container">
                                    <span>记忆列表</span>
                                    <span class="tab-badge">{{ memoryTotal }}</span>
                                </span>
                            </template>
                            <div class="tab-pane-content">
                                <div class="memory-list-panel" v-loading="loading">
                                    <el-empty
                                        v-if="memories.length === 0 && !loading"
                                        description="没有符合条件的记忆"
                                        :image-size="64"
                                    />

                                    <div v-else class="memory-card-list">
                                        <article
                                            v-for="memory in memories"
                                            :key="memory.id"
                                            :class="[
                                                'memory-card',
                                                `memory-card--${memory.type}`,
                                                { 'is-archived': memory.status === 'archived' }
                                            ]"
                                        >
                                            <div class="memory-card-main">
                                                <div class="memory-card-header">
                                                    <div class="memory-card-title-block">
                                                        <div class="memory-card-kicker">
                                                            <span :class="['type-text-span', getMemoryTagType(memory.type)]">
                                                                {{ getMemoryTypeLabel(memory.type) }}
                                                            </span>
                                                            <span :class="['status-text-span', memory.status]">
                                                                {{ getMemoryStatusLabel(memory.status) }}
                                                            </span>
                                                            <span v-if="memory.sentiment" class="memory-emotion">
                                                                {{ memory.sentiment }}
                                                            </span>
                                                        </div>
                                                        <p v-if="memory.summary" class="memory-card-summary">
                                                            {{ memory.summary }}
                                                        </p>
                                                    </div>

                                                    <div class="memory-card-importance">
                                                        <span class="memory-card-importance-label">重要度</span>
                                                        <div
                                                            class="importance-meter"
                                                            :title="memory.importance == null ? '未设置重要度' : `重要度 ${formatImportance(memory.importance)}`"
                                                        >
                                                            <span
                                                                :class="['importance-meter-fill', getImportanceTone(memory.importance)]"
                                                                :style="{ width: formatImportancePercent(memory.importance) }"
                                                            />
                                                        </div>
                                                        <span class="memory-card-importance-value">
                                                            {{ formatImportance(memory.importance) || '-' }}
                                                        </span>
                                                    </div>
                                                </div>

                                                <p class="memory-card-content">
                                                    {{ memory.content }}
                                                </p>

                                                <div class="memory-card-footer">
                                                    <div class="memory-card-meta">
                                                        <span>创建 {{ formatTime(memory.createdAt) }}</span>
                                                        <span>更新 {{ formatTime(memory.updatedAt) }}</span>
                                                    </div>
                                                    <div
                                                        v-if="memory.keywords.length > 0"
                                                        class="memory-keywords"
                                                    >
                                                        <el-tag
                                                            v-for="kw in memory.keywords"
                                                            :key="kw"
                                                            size="small"
                                                            effect="plain"
                                                        >
                                                            {{ kw }}
                                                        </el-tag>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="memory-card-actions">
                                                <el-button size="small" @click="openEditDialog(memory)">
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
                                        v-model:current-page="memoryPage"
                                        v-model:page-size="memoryPageSize"
                                        :total="memoryTotal"
                                        :page-sizes="[20, 50, 100]"
                                        layout="total, sizes, prev, pager, next, jumper"
                                        @current-change="onMemoryPageChange"
                                        @size-change="onMemorySizeChange"
                                    />
                                </div>
                            </div>
                        </el-tab-pane>

                        <el-tab-pane name="snapshots">
                            <template #label>
                                <span class="tab-label-container">
                                    <span>快照列表</span>
                                    <span class="tab-badge">{{ snapshotTotal }}</span>
                                </span>
                            </template>
                            <div class="tab-pane-content">
                                <el-table :data="snapshots" border v-loading="loading">
                                    <el-table-column prop="id" label="ID" min-width="160" header-align="center" />
                                    <el-table-column prop="strategy" label="策略" width="140" align="center" header-align="center" />
                                    <el-table-column prop="query" label="查询" min-width="180" header-align="center" show-overflow-tooltip />
                                    <el-table-column label="命中" width="80" align="center" header-align="center">
                                        <template #default="scope">{{ scope.row.resolvedItems.length }}</template>
                                    </el-table-column>
                                    <el-table-column label="创建时间" min-width="160" align="center" header-align="center">
                                        <template #default="scope">{{ formatTime(scope.row.createdAt) }}</template>
                                    </el-table-column>
                                    <el-table-column label="操作" width="180" align="center" header-align="center" fixed="right">
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
                                        v-model:current-page="snapshotPage"
                                        v-model:page-size="snapshotPageSize"
                                        :total="snapshotTotal"
                                        :page-sizes="[20, 50, 100]"
                                        layout="total, sizes, prev, pager, next, jumper"
                                        @current-change="onSnapshotPageChange"
                                        @size-change="onSnapshotSizeChange"
                                    />
                                </div>
                            </div>
                        </el-tab-pane>

                        <el-tab-pane name="jobs">
                            <template #label>
                                <span class="tab-label-container">
                                    <span>任务列表</span>
                                    <span class="tab-badge">{{ jobTotal }}</span>
                                </span>
                            </template>
                            <div class="tab-pane-content">
                                <el-table :data="jobs" border v-loading="loading">
                                    <el-table-column prop="id" label="ID" min-width="160" header-align="center" />
                                    <el-table-column label="类型" width="120" align="center" header-align="center">
                                        <template #default="scope">
                                            {{ getJobKindLabel(scope.row.kind) }}
                                        </template>
                                    </el-table-column>
                                    <el-table-column label="状态" width="120" align="center" header-align="center">
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
                                    <el-table-column label="创建时间" min-width="160" align="center" header-align="center">
                                        <template #default="scope">{{ formatTime(scope.row.createdAt) }}</template>
                                    </el-table-column>
                                    <el-table-column label="更新时间" min-width="160" align="center" header-align="center">
                                        <template #default="scope">{{ formatTime(scope.row.updatedAt) }}</template>
                                    </el-table-column>
                                </el-table>

                                <div class="pagination-container">
                                    <el-pagination
                                        v-model:current-page="jobPage"
                                        v-model:page-size="jobPageSize"
                                        :total="jobTotal"
                                        :page-sizes="[20, 50, 100]"
                                        layout="total, sizes, prev, pager, next, jumper"
                                        @current-change="onJobPageChange"
                                        @size-change="onJobSizeChange"
                                    />
                                </div>
                            </div>
                        </el-tab-pane>
                    </el-tabs>
                </el-card>
            </div>
        </div>
    </k-layout>

    <!-- Dialogs -->
    <el-dialog
        v-model="dialogVisible"
        :title="dialogTitle"
        width="720px"
        :class="['lm-dialog', isDark ? 'lm-theme-dark' : 'lm-theme-light']"
        modal-class="lm-dialog-overlay"
    >
        <el-form label-width="96px">
            <el-form-item label="类型">
                <el-select
                    v-model="form.type"
                    placeholder="请选择类型"
                    :popper-class="isDark ? 'lm-select-popper lm-theme-dark' : 'lm-select-popper lm-theme-light'"
                >
                    <el-option
                        v-for="item in memoryTypes"
                        :key="item"
                        :label="item"
                        :value="item"
                    />
                </el-select>
            </el-form-item>

            <el-form-item label="状态">
                <el-select
                    v-model="form.status"
                    placeholder="请选择状态"
                    :popper-class="isDark ? 'lm-select-popper lm-theme-dark' : 'lm-select-popper lm-theme-light'"
                >
                    <el-option label="活跃记忆" value="active" />
                    <el-option label="历史记录" value="archived" />
                </el-select>
            </el-form-item>

            <el-form-item label="内容">
                <el-input
                    v-model="form.content"
                    type="textarea"
                    :rows="4"
                    placeholder="请输入记忆内容"
                />
            </el-form-item>

            <el-form-item label="摘要">
                <el-input
                    v-model="form.summary"
                    type="textarea"
                    :rows="2"
                    placeholder="可选，简要概括该记忆"
                />
            </el-form-item>

            <el-form-item label="情绪">
                <el-input
                    v-model="form.sentiment"
                    placeholder="可选，例如：担心、亲近、愉快、中性"
                />
            </el-form-item>

            <el-form-item label="重要度">
                <el-input-number
                    v-model="form.importance"
                    :min="0"
                    :max="1"
                    :step="0.05"
                    :precision="2"
                    controls-position="right"
                    placeholder="可选，0 到 1"
                />
            </el-form-item>

            <el-form-item label="关键词">
                <el-select
                    v-model="form.keywords"
                    multiple
                    filterable
                    allow-create
                    default-first-option
                    placeholder="可输入多个关键词"
                    :popper-class="isDark ? 'lm-select-popper lm-theme-dark' : 'lm-select-popper lm-theme-light'"
                />
            </el-form-item>
        </el-form>

        <template #footer>
            <el-button @click="dialogVisible = false">取消</el-button>
            <el-button :loading="submitPending" type="primary" @click="submitMemory">
                保存
            </el-button>
        </template>
    </el-dialog>

    <el-dialog
        v-model="snapshotDialogVisible"
        title="快照详情"
        width="860px"
        :class="['snapshot-dialog', 'lm-dialog', isDark ? 'lm-theme-dark' : 'lm-theme-light']"
        modal-class="snapshot-dialog-overlay"
    >
        <template v-if="selectedSnapshot != null">
            <div class="snapshot-dialog-meta">
                <div>
                    <span class="snapshot-dialog-label">快照 ID</span>
                    <span>{{ selectedSnapshot.id }}</span>
                </div>
                <div>
                    <span class="snapshot-dialog-label">策略</span>
                    <span>{{ selectedSnapshot.strategy }}</span>
                </div>
                <div>
                    <span class="snapshot-dialog-label">命中</span>
                    <span>{{ selectedSnapshot.resolvedItems.length }}</span>
                </div>
                <div>
                    <span class="snapshot-dialog-label">创建时间</span>
                    <span>{{ formatTime(selectedSnapshot.createdAt) }}</span>
                </div>
                <div class="snapshot-dialog-query">
                    <span class="snapshot-dialog-label">查询</span>
                    <span>{{ selectedSnapshot.query }}</span>
                </div>
            </div>

            <el-empty
                v-if="selectedSnapshot.resolvedItems.length === 0"
                description="该快照没有命中记忆"
                :image-size="64"
            />
            <div v-else class="snapshot-memory-list">
                <div
                    v-for="item in selectedSnapshot.resolvedItems"
                    :key="item.memoryId"
                    class="snapshot-memory-item"
                >
                    <div class="snapshot-memory-header">
                        <el-tag
                            :type="snapshotItemTagType(item)"
                            size="small"
                            effect="plain"
                        >
                            {{ snapshotItemStatusLabel(item) }}
                        </el-tag>
                        <span class="snapshot-memory-id">{{ item.memoryId }}</span>
                        <span class="snapshot-memory-score">
                            score {{ formatScore(item.score) }}
                        </span>
                    </div>

                    <template v-if="item.memory != null">
                        <div class="snapshot-memory-content">
                            {{ item.memory.content }}
                        </div>
                        <div class="snapshot-memory-meta">
                            <span>类型：{{ item.memory.type }}</span>
                            <span>情绪：{{ item.memory.sentiment || '-' }}</span>
                            <span>重要度：{{ formatImportance(item.memory.importance) || '-' }}</span>
                            <span>记录于：{{ formatTime(item.memory.createdAt) }}</span>
                        </div>
                        <div
                            v-if="item.memory.summary"
                            class="snapshot-memory-summary"
                        >
                            摘要：{{ item.memory.summary }}
                        </div>
                        <el-space
                            v-if="item.memory.keywords.length > 0"
                            wrap
                            class="snapshot-memory-keywords"
                        >
                            <el-tag
                                v-for="kw in item.memory.keywords"
                                :key="kw"
                                size="small"
                                effect="plain"
                            >
                                {{ kw }}
                            </el-tag>
                        </el-space>
                    </template>
                    <div v-else class="snapshot-memory-missing">
                        记忆已删除或不可用
                    </div>
                </div>
            </div>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useColorMode } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as api from './api'
import type {
    MemoryEntryRecord,
    MemorySnapshotRecord,
    MemorySnapshotResolvedItem,
    MemoryJobRecord,
    MemoryEntryType,
    MemoryEntryStatus,
    MemoryConfigWarning
} from './types'
import { memoryEntryTypes } from './types'

const memoryTypes = memoryEntryTypes

const formatTime = (value: string | Date | null | undefined): string => {
    if (!value) return ''
    const d = new Date(value as string | number)
    if (isNaN(d.getTime())) return String(value)
    const Y = d.getFullYear()
    const M = String(d.getMonth() + 1).padStart(2, '0')
    const D = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${Y}-${M}-${D} ${h}:${m}`
}

const formatImportance = (value: number | null | undefined): string => {
    if (value == null) return ''
    return Number.isFinite(value) ? value.toFixed(2) : ''
}

const formatScore = (value: number | null | undefined): string => {
    if (value == null) return '-'
    return Number.isFinite(value) ? value.toFixed(4) : String(value)
}

const snapshotItemStatusLabel = (item: MemorySnapshotResolvedItem): string => {
    if (item.missing) return '缺失'
    return item.memory?.status === 'archived' ? '历史' : '活跃'
}

const snapshotItemTagType = (
    item: MemorySnapshotResolvedItem
): 'success' | 'info' | 'danger' => {
    if (item.missing) return 'danger'
    return item.memory?.status === 'archived' ? 'info' : 'success'
}

const normalizeImportanceInput = (value: number | null): number | null => {
    if (value == null || !Number.isFinite(value)) {
        return null
    }

    return Math.min(1, Math.max(0, value))
}

const loading = ref(false)
const dreamPending = ref(false)
const clearPending = ref(false)
const submitPending = ref(false)
const dialogVisible = ref(false)
const editingMemoryId = ref<string | null>(null)
const snapshotDialogVisible = ref(false)
const selectedSnapshot = ref<MemorySnapshotRecord | null>(null)
const deletingSnapshotId = ref<string | null>(null)

const presetId = ref('')
const presetIds = ref<string[]>([])
const memoryKeyword = ref('')
const memoryType = ref<MemoryEntryType | ''>('')
const memoryStatus = ref<MemoryEntryStatus | 'all'>('active')

const memoryPage = ref(1)
const memoryPageSize = ref(20)
const memoryTotal = ref(0)

const snapshotPage = ref(1)
const snapshotPageSize = ref(20)
const snapshotTotal = ref(0)

const jobPage = ref(1)
const jobPageSize = ref(20)
const jobTotal = ref(0)

const memories = ref<MemoryEntryRecord[]>([])
const snapshots = ref<MemorySnapshotRecord[]>([])
const jobs = ref<MemoryJobRecord[]>([])
const configWarnings = ref<MemoryConfigWarning[]>([])

// Cache total dataset of entries for counting status and type amounts in local filters
const allPresetMemories = ref<MemoryEntryRecord[]>([])

// Filter memories by current status for secondary category counts
const statusFilteredMemories = computed(() => {
    if (memoryStatus.value === 'all') {
        return allPresetMemories.value
    }
    return allPresetMemories.value.filter(item => item.status === memoryStatus.value)
})

const totalMemoryCount = computed(() => statusFilteredMemories.value.length)

const getStatusCount = (status: 'active' | 'archived' | 'all') => {
    if (status === 'all') {
        return allPresetMemories.value.length
    }
    return allPresetMemories.value.filter(item => item.status === status).length
}

const getTypeCount = (type: MemoryEntryType | '') => {
    if (type === '') {
        return statusFilteredMemories.value.length
    }
    return statusFilteredMemories.value.filter(item => item.type === type).length
}

const activeTab = ref('memories')

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const statusOptions = [
    { label: '活跃记忆', value: 'active' as const },
    { label: '归档记忆', value: 'archived' as const },
    { label: '全部记忆', value: 'all' as const }
]

const setMemoryStatus = (status: 'active' | 'archived' | 'all') => {
    memoryStatus.value = status
    onMemoryFilterChange()
}

const setMemoryType = (type: MemoryEntryType | '') => {
    memoryType.value = type
    onMemoryFilterChange()
}

const resetFilters = () => {
    memoryKeyword.value = ''
    memoryStatus.value = 'active'
    memoryType.value = ''
    onMemoryFilterChange()
}

const fetchConfigStatus = async () => {
    try {
        const status = await api.getStatus()
        configWarnings.value = status.warnings ?? []
    } catch {
        configWarnings.value = []
    }
}

const form = reactive({
    type: 'fact' as MemoryEntryType,
    status: 'active' as MemoryEntryStatus,
    content: '',
    keywords: [] as string[],
    summary: '',
    sentiment: '',
    importance: null as number | null
})

const dialogTitle = computed(() =>
    editingMemoryId.value == null ? '新建记忆' : '编辑记忆'
)

const ensurePreset = () => {
    if (presetId.value.trim().length > 0) {
        return true
    }
    ElMessage.warning('请先输入预设 ID')
    return false
}

const normalizePreset = () => {
    presetId.value = presetId.value.trim()
}

const resetForm = () => {
    form.type = 'fact'
    form.status = 'active'
    form.content = ''
    form.keywords = []
    form.summary = ''
    form.sentiment = ''
    form.importance = null
    editingMemoryId.value = null
}

const getMemoryTypeLabel = (type: string): string => {
    const labels: Record<string, string> = {
        identity: '身份',
        preference: '偏好',
        fact: '事实',
        plan: '计划',
        context: '上下文',
        other: '其它'
    }
    return labels[type] || type
}

const getMemoryTagType = (
    type: string
): 'success' | 'warning' | 'danger' | 'info' | '' => {
    const types: Record<string, 'success' | 'warning' | 'danger' | 'info' | ''> = {
        identity: '',
        preference: 'success',
        fact: 'info',
        plan: 'warning',
        context: 'danger',
        other: 'info'
    }
    return types[type] || 'info'
}

const getMemoryStatusLabel = (status: MemoryEntryStatus): string => {
    return status === 'archived' ? '归档' : '活跃'
}

const clampImportance = (value: number | null | undefined): number | null => {
    if (value == null || !Number.isFinite(value)) {
        return null
    }

    return Math.min(1, Math.max(0, value))
}

const getImportanceTone = (
    value: number | null | undefined
): 'high' | 'medium' | 'low' | 'empty' => {
    const normalized = clampImportance(value)
    if (normalized == null) {
        return 'empty'
    }
    if (normalized >= 0.7) {
        return 'high'
    }
    if (normalized >= 0.4) {
        return 'medium'
    }
    return 'low'
}

const formatImportancePercent = (value: number | null | undefined): string => {
    const normalized = clampImportance(value)
    if (normalized == null) {
        return '0%'
    }

    return `${Math.round(normalized * 100)}%`
}

const getJobKindLabel = (kind: string): string => {
    const labels: Record<string, string> = {
        recall: '记忆召回',
        extract: '记忆提取',
        dream: 'Dream 固化',
        clear: '数据清理'
    }
    return labels[kind] || kind
}

const getJobStatusLabel = (status: string): string => {
    const labels: Record<string, string> = {
        pending: '排队中',
        running: '运行中',
        completed: '已完成',
        failed: '已失败'
    }
    return labels[status] || status
}

const getJobStatusTagType = (
    status: string
): 'success' | 'warning' | 'danger' | 'info' => {
    const types: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
        pending: 'info',
        running: 'warning',
        completed: 'success',
        failed: 'danger'
    }
    return types[status] || 'info'
}

const fetchPresetIds = async () => {
    try {
        presetIds.value = await api.listPresetIds()
    } catch {
        // 静默失败，用户仍可手动输入
    }
}

const onPresetChange = () => {
    refreshAll()
}

const onPresetVisibleChange = (visible: boolean) => {
    if (visible) {
        fetchPresetIds()
    }
}

const onMemoryFilterChange = () => {
    memoryPage.value = 1
    fetchMemories()
}

const onMemoryPageChange = (page: number) => {
    memoryPage.value = page
    fetchMemories()
}

const onMemorySizeChange = (size: number) => {
    memoryPageSize.value = size
    memoryPage.value = 1
    fetchMemories()
}

const onSnapshotPageChange = (page: number) => {
    snapshotPage.value = page
    fetchSnapshots()
}

const onSnapshotSizeChange = (size: number) => {
    snapshotPageSize.value = size
    snapshotPage.value = 1
    fetchSnapshots()
}

const onJobPageChange = (page: number) => {
    jobPage.value = page
    fetchJobs()
}

const onJobSizeChange = (size: number) => {
    jobPageSize.value = size
    jobPage.value = 1
    fetchJobs()
}

const fetchMemories = async (skipLoading = false) => {
    if (!ensurePreset()) return
    if (!skipLoading) loading.value = true
    try {
        // Fetch all memories for local counts cache first
        const allResult = await api.listMemories({
            presetId: presetId.value,
            page: 1,
            pageSize: 100000 // A large number to fetch everything in this preset for counts
        })
        allPresetMemories.value = allResult.items

        const result = await api.listMemories({
            presetId: presetId.value,
            keyword: memoryKeyword.value.trim() || undefined,
            type: memoryType.value || undefined,
            status: memoryStatus.value,
            page: memoryPage.value,
            pageSize: memoryPageSize.value
        })
        memories.value = result.items
        memoryTotal.value = result.total
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取记忆失败：${message}`)
    } finally {
        if (!skipLoading) loading.value = false
    }
}

const fetchSnapshots = async (skipLoading = false) => {
    if (!ensurePreset()) return
    if (!skipLoading) loading.value = true
    try {
        const result = await api.listSnapshots({
            presetId: presetId.value,
            page: snapshotPage.value,
            pageSize: snapshotPageSize.value
        })
        snapshots.value = result.items
        snapshotTotal.value = result.total
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取快照失败：${message}`)
    } finally {
        if (!skipLoading) loading.value = false
    }
}

const fetchJobs = async (skipLoading = false) => {
    if (!ensurePreset()) return
    if (!skipLoading) loading.value = true
    try {
        const result = await api.listJobs({
            presetId: presetId.value,
            page: jobPage.value,
            pageSize: jobPageSize.value
        })
        jobs.value = result.items
        jobTotal.value = result.total
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取任务失败：${message}`)
    } finally {
        if (!skipLoading) loading.value = false
    }
}

const refreshAll = async () => {
    normalizePreset()
    if (!ensurePreset()) {
        memories.value = []
        snapshots.value = []
        jobs.value = []
        memoryTotal.value = 0
        snapshotTotal.value = 0
        jobTotal.value = 0
        return
    }

    loading.value = true
    memoryPage.value = 1
    snapshotPage.value = 1
    jobPage.value = 1

    try {
        await Promise.all([
            fetchMemories(true),
            fetchSnapshots(true),
            fetchJobs(true)
        ])
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`刷新失败：${message}`)
    } finally {
        loading.value = false
    }
}

const openCreateDialog = () => {
    if (!ensurePreset()) return
    resetForm()
    dialogVisible.value = true
}

const openEditDialog = (memory: MemoryEntryRecord) => {
    editingMemoryId.value = memory.id
    form.type = memory.type
    form.status = memory.status
    form.content = memory.content
    form.keywords = [...memory.keywords]
    form.summary = memory.summary ?? ''
    form.sentiment = memory.sentiment ?? ''
    form.importance = memory.importance ?? null
    dialogVisible.value = true
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
        await refreshAll()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`删除失败：${message}`)
    } finally {
        deletingSnapshotId.value = null
    }
}

const submitMemory = async () => {
    normalizePreset()
    if (!ensurePreset()) return

    const content = form.content.trim()
    if (content.length === 0) {
        ElMessage.warning('记忆内容不能为空')
        return
    }

    submitPending.value = true

    const mutation = {
        type: form.type,
        status: form.status,
        content,
        keywords: form.keywords,
        summary: form.summary.trim() || null,
        sentiment: form.sentiment.trim() || null,
        importance: normalizeImportanceInput(form.importance)
    }

    try {
        if (editingMemoryId.value == null) {
            await api.createMemory(presetId.value, mutation)
            ElMessage.success('记忆已创建')
        } else {
            await api.updateMemory(editingMemoryId.value, mutation)
            ElMessage.success('记忆已更新')
        }

        dialogVisible.value = false
        resetForm()
        await refreshAll()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`保存失败：${message}`)
    } finally {
        submitPending.value = false
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
        await refreshAll()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`删除失败：${message}`)
    }
}

const runDreamJob = async () => {
    normalizePreset()
    if (!ensurePreset()) return

    dreamPending.value = true

    try {
        const result = await api.runDream(presetId.value)
        if (result.started) {
            ElMessage.success('Dream 任务已触发')
        } else if (result.reason === 'preset-locked') {
            ElMessage.info('Dream 任务正在运行')
        }
        await refreshAll()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`Dream 触发失败：${message}`)
    } finally {
        dreamPending.value = false
    }
}

const doClearPresetData = async () => {
    normalizePreset()
    if (!ensurePreset()) return

    try {
        await ElMessageBox.confirm(
            `该操作会清空预设 ${presetId.value} 的全部记忆、快照和任务记录，且不可恢复。是否继续？`,
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

    clearPending.value = true

    try {
        await api.clearPresetData(presetId.value)
        ElMessage.success('该预设的数据已清空')
        await refreshAll()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`清空失败：${message}`)
    } finally {
        clearPending.value = false
    }
}

onMounted(() => {
    fetchPresetIds()
    fetchConfigStatus()
})
</script>

<style scoped>
/* Define global/local variables on body for seamless teleported component styles */
.living-memory-dashboard.lm-theme-light {
    --lm-bg-primary: #ffffff;
    --lm-bg-secondary: #f8f9fa;
    --lm-bg-hover: #f1f3f5;
    --lm-border: #e9ecef;
    --lm-border-hover: #dee2e6;
    --lm-text-primary: #212529;
    --lm-text-secondary: #495057;
    --lm-text-tertiary: #868e96;
    --lm-primary: #2563eb;
    --lm-primary-hover: #1d4ed8;
    --lm-primary-light: #eff6ff;
    --lm-success: #10b981;
    --lm-success-light: #ecfdf5;
    --lm-warning: #f59e0b;
    --lm-warning-light: #fefbeb;
    --lm-danger: #ef4444;
    --lm-danger-light: #fef2f2;
    --lm-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.02);
    --lm-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --lm-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

    /* Element Plus Overrides mapping */
    --el-color-primary: var(--lm-primary) !important;
    --el-color-success: var(--lm-success) !important;
    --el-color-warning: var(--lm-warning) !important;
    --el-color-danger: var(--lm-danger) !important;
    --el-text-color-primary: var(--lm-text-primary) !important;
    --el-text-color-regular: var(--lm-text-secondary) !important;
    --el-text-color-secondary: var(--lm-text-tertiary) !important;
    --el-border-color: var(--lm-border) !important;
    --el-border-color-light: var(--lm-border) !important;
    --el-border-color-lighter: var(--lm-border) !important;
    --el-fill-color-blank: var(--lm-bg-primary) !important;
    --el-bg-color: var(--lm-bg-primary) !important;
    --el-bg-color-overlay: var(--lm-bg-primary) !important;
}

.living-memory-dashboard.lm-theme-dark {
    --lm-bg-primary: #18181b;
    --lm-bg-secondary: #09090b;
    --lm-bg-hover: #27272a;
    --lm-border: #27272a;
    --lm-border-hover: #3f3f46;
    --lm-text-primary: #f4f4f5;
    --lm-text-secondary: #a1a1aa;
    --lm-text-tertiary: #71717a;
    --lm-primary: #3b82f6;
    --lm-primary-hover: #60a5fa;
    --lm-primary-light: rgba(59, 130, 246, 0.1);
    --lm-success: #10b981;
    --lm-success-light: rgba(16, 185, 129, 0.1);
    --lm-warning: #f59e0b;
    --lm-warning-light: rgba(245, 158, 11, 0.1);
    --lm-danger: #ef4444;
    --lm-danger-light: rgba(239, 68, 68, 0.1);
    --lm-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2);
    --lm-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --lm-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

    /* Element Plus Overrides mapping */
    --el-color-primary: var(--lm-primary) !important;
    --el-color-success: var(--lm-success) !important;
    --el-color-warning: var(--lm-warning) !important;
    --el-color-danger: var(--lm-danger) !important;
    --el-text-color-primary: var(--lm-text-primary) !important;
    --el-text-color-regular: var(--lm-text-secondary) !important;
    --el-text-color-secondary: var(--lm-text-tertiary) !important;
    --el-border-color: var(--lm-border) !important;
    --el-border-color-light: var(--lm-border) !important;
    --el-border-color-lighter: var(--lm-border) !important;
    --el-fill-color-blank: var(--lm-bg-primary) !important;
    --el-bg-color: var(--lm-bg-primary) !important;
    --el-bg-color-overlay: var(--lm-bg-primary) !important;
}

/* Also define custom variables for Dialogs, mapped locally per dialog element state */
:global(.lm-dialog.lm-theme-light) {
    --lm-bg-primary: #ffffff;
    --lm-bg-secondary: #f8f9fa;
    --lm-bg-hover: #f1f3f5;
    --lm-border: #e9ecef;
    --lm-border-hover: #dee2e6;
    --lm-text-primary: #212529;
    --lm-text-secondary: #495057;
    --lm-text-tertiary: #868e96;
    --lm-primary: #2563eb;
    --lm-primary-hover: #1d4ed8;
    --lm-primary-light: #eff6ff;
    --lm-success: #10b981;
    --lm-success-light: #ecfdf5;
    --lm-warning: #f59e0b;
    --lm-warning-light: #fefbeb;
    --lm-danger: #ef4444;
    --lm-danger-light: #fef2f2;
    --lm-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.02);
    --lm-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --lm-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

    --el-color-primary: var(--lm-primary) !important;
    --el-text-color-primary: var(--lm-text-primary) !important;
    --el-text-color-regular: var(--lm-text-secondary) !important;
    --el-border-color: var(--lm-border) !important;
    --el-border-color-light: var(--lm-border) !important;
    --el-border-color-lighter: var(--lm-border) !important;
    --el-fill-color-blank: var(--lm-bg-primary) !important;
    --el-bg-color: var(--lm-bg-primary) !important;
    --el-bg-color-overlay: var(--lm-bg-primary) !important;
}

:global(.lm-dialog.lm-theme-dark) {
    --lm-bg-primary: #18181b;
    --lm-bg-secondary: #09090b;
    --lm-bg-hover: #27272a;
    --lm-border: #27272a;
    --lm-border-hover: #3f3f46;
    --lm-text-primary: #f4f4f5;
    --lm-text-secondary: #a1a1aa;
    --lm-text-tertiary: #71717a;
    --lm-primary: #3b82f6;
    --lm-primary-hover: #60a5fa;
    --lm-primary-light: rgba(59, 130, 246, 0.1);
    --lm-success: #10b981;
    --lm-success-light: rgba(16, 185, 129, 0.1);
    --lm-warning: #f59e0b;
    --lm-warning-light: rgba(245, 158, 11, 0.1);
    --lm-danger: #ef4444;
    --lm-danger-light: rgba(239, 68, 68, 0.1);
    --lm-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2);
    --lm-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --lm-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

    --el-color-primary: var(--lm-primary) !important;
    --el-text-color-primary: var(--lm-text-primary) !important;
    --el-text-color-regular: var(--lm-text-secondary) !important;
    --el-border-color: var(--lm-border) !important;
    --el-border-color-light: var(--lm-border) !important;
    --el-border-color-lighter: var(--lm-border) !important;
    --el-fill-color-blank: var(--lm-bg-primary) !important;
    --el-bg-color: var(--lm-bg-primary) !important;
    --el-bg-color-overlay: var(--lm-bg-primary) !important;
}

/* Base styles styling */
.living-memory-dashboard {
    height: 100%;
    background-color: var(--lm-bg-secondary) !important;
    color: var(--lm-text-primary);
    font-family: var(--lm-font-sans);
    transition: background-color 150ms ease, color 150ms ease;
}

.living-memory-dashboard :deep(.layout-main) {
    overflow-y: auto;
    background-color: transparent !important;
}

.living-memory-dashboard :deep(.layout-content) {
    overflow-y: auto;
}

.dashboard-shell {
    max-width: 1600px;
    margin: 0 auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    overflow-y: auto;
}

/* Card layout wrapper */
:deep(.el-card) {
    background-color: var(--lm-bg-primary) !important;
    border: 1px solid var(--lm-border) !important;
    border-radius: 6px !important;
    box-shadow: var(--lm-shadow) !important;
    transition: border-color 150ms ease, box-shadow 150ms ease;
}

:deep(.el-card__header) {
    border-bottom: 1px solid var(--lm-border) !important;
    padding: 12px 20px !important;
    background-color: var(--lm-bg-primary) !important;
}

/* Toolbar Header style */
.toolbar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
}

.toolbar-title {
    font-family: var(--lm-font-mono);
    font-weight: 700;
    font-size: 16px;
    letter-spacing: 0.05em;
    color: var(--lm-text-primary);
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 8px;
}

.toolbar-title::before {
    content: '';
    display: inline-block;
    width: 4px;
    height: 16px;
    background-color: var(--lm-primary);
    border-radius: 2px;
}

/* Grid parameters */
.toolbar-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
}

@media (min-width: 768px) {
    .toolbar-grid {
        grid-template-columns: 1fr auto;
        align-items: center;
    }
}

.filter-group-horizontal {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
}

.field-label-inline {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--lm-text-tertiary);
    font-family: var(--lm-font-mono);
    white-space: nowrap;
}

.preset-select {
    max-width: 240px;
}

/* Layout for Sidebar panel & List details */
.dashboard-body-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 20px;
    align-items: stretch;
    height: calc(100vh - 220px);
    min-height: 500px;
}

@media (max-width: 1024px) {
    .dashboard-body-layout {
        grid-template-columns: 1fr;
        align-items: start;
        height: auto;
    }
}

/* Category Filter Card Styles */
.category-card {
    border-radius: 6px !important;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
}

.category-card :deep(.el-card__header) {
    height: 52px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
}

.category-card :deep(.el-card__body) {
    flex: 1;
    overflow-y: auto;
}

.category-filters-vertical {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.category-item-vertical {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.category-label-vertical {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--lm-text-tertiary);
    font-family: var(--lm-font-mono);
}

.category-options-vertical {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.category-btn-vertical {
    background-color: var(--lm-bg-secondary);
    border: 1px solid var(--lm-border);
    color: var(--lm-text-secondary);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    font-family: var(--lm-font-sans);
    transition: all 120ms ease;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.btn-text-content {
    flex: 1;
}

.btn-count-badge {
    font-family: var(--lm-font-mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 8px;
    background-color: var(--lm-bg-hover);
    color: var(--lm-text-tertiary);
    margin-left: 8px;
    border: 1px solid var(--lm-border);
}

.category-btn-vertical.active .btn-count-badge {
    background-color: var(--lm-primary);
    color: #ffffff;
    border-color: var(--lm-primary);
}

.category-btn-vertical:hover {
    background-color: var(--lm-bg-hover);
    color: var(--lm-text-primary);
    border-color: var(--lm-border-hover);
}

.category-btn-vertical.active {
    background-color: var(--lm-primary-light);
    border-color: var(--lm-primary);
    color: var(--lm-primary);
    font-weight: 600;
}

.category-reset-container {
    border-top: 1px solid var(--lm-border);
    padding-top: 16px;
    margin-top: 4px;
}

.reset-filter-btn {
    background-color: var(--lm-bg-primary);
    border: 1px dashed var(--lm-border);
    color: var(--lm-text-secondary);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
    width: 100%;
    font-family: var(--lm-font-sans);
    transition: all 150ms ease;
}

.reset-filter-btn:hover {
    background-color: var(--lm-bg-hover);
    border-color: var(--lm-border-hover);
    color: var(--lm-text-primary);
}

/* Custom Overrides for Input & Selects */
:deep(.el-input__wrapper),
:deep(.el-select .el-input__wrapper),
:global(.lm-dialog .el-input__wrapper),
:global(.lm-dialog .el-textarea__inner) {
    background-color: var(--lm-bg-secondary) !important;
    border: 1px solid var(--lm-border) !important;
    box-shadow: none !important;
    border-radius: 4px !important;
    padding: 4px 12px !important;
    color: var(--lm-text-primary) !important;
    transition: border-color 150ms ease, background-color 150ms ease;
}

:deep(.el-input__wrapper:hover),
:deep(.el-select .el-input__wrapper:hover),
:deep(.el-input__wrapper.is-focus),
:deep(.el-select .el-input__wrapper.is-focus),
:global(.lm-dialog .el-input__wrapper:hover),
:global(.lm-dialog .el-textarea__inner:hover),
:global(.lm-dialog .el-input__wrapper.is-focus),
:global(.lm-dialog .el-textarea__inner:focus) {
    border-color: var(--lm-border-hover) !important;
    background-color: var(--lm-bg-primary) !important;
}

:deep(.el-input__inner),
:global(.lm-dialog .el-input__inner),
:global(.lm-dialog .el-textarea__inner) {
    color: var(--lm-text-primary) !important;
    font-family: var(--lm-font-sans);
    font-size: 13px !important;
}

:deep(.el-input__inner::placeholder),
:global(.lm-dialog .el-input__inner::placeholder) {
    color: var(--lm-text-tertiary) !important;
}

:deep(.el-select),
:deep(.el-input) {
    width: 100% !important;
}

/* Dialog & Dropdown Theme Sync (Fixes transparent dropdown backgrounds) */
:global(.lm-select-popper.lm-theme-light),
:global(.lm-select-popper.lm-theme-light .el-select-dropdown),
:global(.lm-select-popper.lm-theme-light .el-select-dropdown__wrap),
:global(.lm-select-popper.lm-theme-light .el-select-dropdown__list) {
    background-color: #ffffff !important;
    border: 1px solid #e9ecef !important;
    color: #212529 !important;
}

:global(.lm-select-popper.lm-theme-dark),
:global(.lm-select-popper.lm-theme-dark .el-select-dropdown),
:global(.lm-select-popper.lm-theme-dark .el-select-dropdown__wrap),
:global(.lm-select-popper.lm-theme-dark .el-select-dropdown__list) {
    background-color: #18181b !important;
    border: 1px solid #27272a !important;
    color: #f4f4f5 !important;
}

:global(.lm-select-popper .el-select-dropdown__item) {
    color: var(--lm-text-secondary) !important;
}

:global(.lm-select-popper .el-select-dropdown__item.is-hovering),
:global(.lm-select-popper .el-select-dropdown__item:hover) {
    background-color: var(--lm-bg-hover) !important;
    color: var(--lm-text-primary) !important;
}

:global(.lm-select-popper .el-select-dropdown__item.is-selected) {
    color: var(--lm-primary) !important;
    background-color: var(--lm-primary-light) !important;
    font-weight: bold;
}

/* Button overrides */
:deep(.el-button),
:global(.lm-dialog .el-button) {
    border-radius: 4px !important;
    font-weight: 500 !important;
    font-family: var(--lm-font-sans);
    padding: 8px 16px !important;
    font-size: 13px !important;
    transition: all 150ms ease !important;
    box-shadow: none !important;
}

:deep(.el-button--default),
:global(.lm-dialog .el-button--default) {
    background-color: var(--lm-bg-primary) !important;
    border: 1px solid var(--lm-border) !important;
    color: var(--lm-text-secondary) !important;
}

:deep(.el-button--default:hover),
:global(.lm-dialog .el-button--default:hover) {
    background-color: var(--lm-bg-hover) !important;
    color: var(--lm-text-primary) !important;
    border-color: var(--lm-border-hover) !important;
}

:deep(.el-button--primary),
:global(.lm-dialog .el-button--primary) {
    background-color: var(--lm-primary) !important;
    border: 1px solid var(--lm-primary) !important;
    color: #ffffff !important;
}

:deep(.el-button--primary:hover),
:global(.lm-dialog .el-button--primary:hover) {
    background-color: var(--lm-primary-hover) !important;
    border-color: var(--lm-primary-hover) !important;
    color: #ffffff !important;
}

:deep(.el-button--danger),
:global(.lm-dialog .el-button--danger) {
    background-color: var(--lm-danger) !important;
    border: 1px solid var(--lm-danger) !important;
    color: #ffffff !important;
}

:deep(.el-button--danger.is-plain) {
    background-color: var(--lm-danger-light) !important;
    border: 1px solid var(--lm-danger) !important;
    color: var(--lm-danger) !important;
}

:deep(.el-button--danger.is-plain:hover) {
    background-color: var(--lm-danger) !important;
    color: #ffffff !important;
}

:deep(.el-button.is-disabled),
:global(.lm-dialog .el-button.is-disabled) {
    background-color: var(--lm-bg-secondary) !important;
    border-color: var(--lm-border) !important;
    color: var(--lm-text-tertiary) !important;
    opacity: 0.6;
}

/* Prevent layout shifts when loading is active on the refresh button */
.refresh-btn-wrapper {
    display: inline-flex;
    width: 68px; /* Fixed width matching the exact size of the refresh button */
    height: 32px;
}

.refresh-btn-wrapper :deep(.refresh-button) {
    width: 100% !important;
    padding: 0 !important;
    justify-content: center;
    align-items: center;
}

.toolbar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
}

/* Warnings */
.config-warning-banner {
    border-radius: 6px !important;
    border: 1px solid var(--lm-warning) !important;
    background-color: var(--lm-warning-light) !important;
    color: var(--lm-text-primary) !important;
}

.config-warning-list {
    margin: 4px 0 0;
    padding-left: 20px;
}

.config-warning-list li + li {
    margin-top: 4px;
}

/* Memory card list */
.memory-list-panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px;
    border: 1px solid var(--lm-border);
    border-radius: 4px;
    background-color: var(--lm-bg-secondary);
}

.memory-card-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.memory-card {
    --memory-accent: var(--lm-primary);
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    padding: 16px 16px 16px 18px;
    border: 1px solid var(--lm-border);
    border-radius: 6px;
    background-color: var(--lm-bg-primary);
    box-shadow: var(--lm-shadow);
    transition: border-color 150ms ease, background-color 150ms ease;
}

.memory-card::before {
    content: '';
    position: absolute;
    inset: 12px auto 12px 0;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background-color: var(--memory-accent);
}

.memory-card:hover {
    border-color: var(--lm-border-hover);
}

.memory-card.is-archived {
    opacity: 0.82;
}

.memory-card--identity {
    --memory-accent: var(--lm-primary);
}

.memory-card--preference {
    --memory-accent: var(--lm-success);
}

.memory-card--fact {
    --memory-accent: var(--lm-text-secondary);
}

.memory-card--plan {
    --memory-accent: var(--lm-warning);
}

.memory-card--context {
    --memory-accent: var(--lm-danger);
}

.memory-card--other {
    --memory-accent: var(--lm-text-tertiary);
}

.memory-card-main {
    min-width: 0;
}

.memory-card-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 150px;
    gap: 18px;
    align-items: start;
}

.memory-card-title-block {
    min-width: 0;
}

.memory-card-kicker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.memory-emotion {
    display: inline-flex;
    align-items: center;
    max-width: 160px;
    padding: 2px 8px;
    border: 1px solid var(--lm-border);
    border-radius: 999px;
    background-color: var(--lm-bg-secondary);
    color: var(--lm-text-secondary);
    font-size: 12px;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.memory-card-summary {
    margin: 8px 0 0;
    color: var(--lm-text-primary);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.memory-card-content {
    margin: 12px 0 0;
    color: var(--lm-text-primary);
    font-size: 14px;
    line-height: 1.65;
    white-space: pre-wrap;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.memory-card-importance {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 10px;
    align-items: center;
}

.memory-card-importance-label {
    grid-column: 1 / -1;
    color: var(--lm-text-tertiary);
    font-size: 11px;
    font-weight: 600;
}

.memory-card-importance-value {
    color: var(--lm-text-secondary);
    font-family: var(--lm-font-mono);
    font-size: 12px;
    font-weight: 600;
}

.importance-meter {
    width: 100%;
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background-color: var(--lm-bg-hover);
}

.importance-meter-fill {
    display: block;
    height: 100%;
    min-width: 0;
    border-radius: inherit;
    background-color: var(--lm-text-tertiary);
    transition: width 150ms ease;
}

.importance-meter-fill.high {
    background-color: var(--lm-danger);
}

.importance-meter-fill.medium {
    background-color: var(--lm-primary);
}

.importance-meter-fill.low {
    background-color: var(--lm-text-tertiary);
}

.importance-meter-fill.empty {
    background-color: transparent;
}

.memory-card-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 16px;
    align-items: center;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed var(--lm-border);
}

.memory-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: var(--lm-text-tertiary);
    font-family: var(--lm-font-mono);
    font-size: 11px;
}

.memory-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-left: auto;
}

.memory-card-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;
    justify-content: flex-start;
    width: 72px;
}

.memory-card-actions :deep(.el-button) {
    width: 100%;
    margin-left: 0 !important;
}

@media (max-width: 768px) {
    .memory-list-panel {
        padding: 10px;
    }

    .memory-card {
        grid-template-columns: 1fr;
    }

    .memory-card-header {
        grid-template-columns: 1fr;
    }

    .memory-card-importance {
        max-width: 220px;
    }

    .memory-keywords {
        margin-left: 0;
    }

    .memory-card-actions {
        flex-direction: row;
        width: 100%;
    }
}

/* Tables styling */
:deep(.el-table) {
    background-color: var(--lm-bg-primary) !important;
    border: 1px solid var(--lm-border) !important;
    border-radius: 4px !important;
}

:deep(.el-table th.el-table__cell) {
    background-color: var(--lm-bg-secondary) !important;
    color: var(--lm-text-secondary) !important;
    font-weight: 600 !important;
    font-size: 11px !important;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: var(--lm-font-mono);
    border-bottom: 1px solid var(--lm-border) !important;
    padding: 10px 0 !important;
}

:deep(.el-table td.el-table__cell) {
    border-bottom: 1px solid var(--lm-border) !important;
    color: var(--lm-text-primary) !important;
    font-size: 13px !important;
    padding: 8px 0 !important;
}

:deep(.el-table--border .el-table__inner-wrapper::after),
:deep(.el-table--border::after),
:deep(.el-table--border::before) {
    background-color: var(--lm-border) !important;
}

:deep(.el-table__border-left-patch) {
    background-color: var(--lm-border) !important;
}

:deep(.el-table--border .el-table__cell) {
    border-right: 1px solid var(--lm-border) !important;
}

:deep(.el-table__row:hover > td.el-table__cell) {
    background-color: var(--lm-bg-hover) !important;
}

/* Custom plain text labels for type and status columns */
.type-text-span,
.status-text-span {
    font-size: 13px;
    font-weight: 600;
    font-family: var(--lm-font-sans);
}

/* Type colors mapping from getMemoryTagType classes */
.type-text-span.success {
    color: var(--lm-success);
}
.type-text-span.info {
    color: var(--lm-text-secondary);
}
.type-text-span.warning {
    color: var(--lm-warning);
}
.type-text-span.danger {
    color: var(--lm-danger);
}
.type-text-span.identity {
    color: var(--lm-primary); /* Empty mapping, fallback to primary */
}
.type-text-span:not(.success):not(.info):not(.warning):not(.danger) {
    color: var(--lm-primary);
}

/* Status colors mapping */
.status-text-span.active {
    color: var(--lm-success);
}
.status-text-span.archived {
    color: var(--lm-text-tertiary);
}

/* Tag colors */
:deep(.el-tag) {
    border-radius: 3px !important;
    font-weight: 500 !important;
    font-size: 11px !important;
    font-family: var(--lm-font-mono);
    padding: 2px 6px !important;
    height: auto !important;
    line-height: 1.2 !important;
    border: 1px solid currentColor !important;
}

:deep(.el-tag--plain.el-tag--info) {
    background-color: var(--lm-bg-secondary) !important;
    border-color: var(--lm-border) !important;
    color: var(--lm-text-secondary) !important;
}

/* Tab Header & Custom Styling inside consolidated main card */
.main-content-card {
    border-radius: 6px !important;
    display: flex;
    flex-direction: column;
}

.main-content-card :deep(.el-card__header) {
    display: none;
}

.main-content-card :deep(.el-card__body) {
    padding: 0 20px 20px 20px !important;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
}

.card-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--lm-text-primary);
    font-family: var(--lm-font-sans);
}

.custom-tabs {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
}

.custom-tabs :deep(.el-tabs__header) {
    margin: 0 0 20px 0 !important;
    border-bottom: 1px solid var(--lm-border) !important;
}

.custom-tabs :deep(.el-tabs__nav-wrap) {
    width: 100%;
}

.custom-tabs :deep(.el-tabs__nav-wrap::after) {
    display: none !important;
}

.custom-tabs :deep(.el-tabs__item) {
    font-family: var(--lm-font-sans) !important;
    font-size: 14px !important;
    font-weight: 600 !important;
    color: var(--lm-text-secondary) !important;
    height: 52px !important;
    line-height: 52px !important;
}

.custom-tabs :deep(.el-tabs__item.is-active) {
    color: var(--lm-primary) !important;
}

.custom-tabs :deep(.el-tabs__nav) {
    height: 52px !important;
}

.custom-tabs :deep(.el-tabs__active-bar) {
    bottom: 0 !important;
}

.custom-tabs :deep(.el-tabs__content) {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    margin-top: 0px;
}

.custom-tabs :deep(.el-tab-pane) {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
}

.tab-pane-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    flex: 1;
    min-height: 0;
}

.tab-label-container {
    font-family: var(--lm-font-sans) !important;
    font-weight: 600 !important;
    display: inline-flex;
    align-items: center;
}

.tab-badge {
    font-family: var(--lm-font-mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 8px;
    background-color: var(--lm-bg-hover);
    color: var(--lm-text-tertiary);
    margin-left: 6px;
    border: 1px solid var(--lm-border);
    font-weight: normal;
    line-height: 1.2;
    transition: all 120ms ease;
}

.custom-tabs :deep(.el-tabs__item.is-active) .tab-badge {
    background-color: var(--lm-primary-light);
    color: var(--lm-primary);
    border-color: var(--lm-primary);
}

/* Pagination */
.pagination-container {
    display: flex;
    justify-content: flex-end;
    padding-top: 20px;
    margin-top: auto;
    border-top: 1px solid var(--lm-border);
    background-color: transparent;
}

.pagination-container :deep(.el-pagination) {
    gap: 12px;
}

.pagination-container :deep(.el-pagination__sizes) {
    margin-right: 16px;
}

.pagination-container :deep(.el-pagination__jump) {
    margin-left: 16px;
}

:deep(.el-pagination button),
:deep(.el-pagination .el-pager li) {
    background-color: var(--lm-bg-primary) !important;
    border: 1px solid var(--lm-border) !important;
    color: var(--lm-text-secondary) !important;
    border-radius: 4px !important;
    font-family: var(--lm-font-mono) !important;
    font-size: 12px !important;
    min-width: 28px !important;
    height: 28px !important;
    line-height: 26px !important;
    margin: 0 2px !important;
    transition: all 150ms ease !important;
}

:deep(.el-pagination button:hover),
:deep(.el-pagination .el-pager li:hover) {
    border-color: var(--lm-border-hover) !important;
    color: var(--lm-text-primary) !important;
    background-color: var(--lm-bg-hover) !important;
}

:deep(.el-pagination .el-pager li.is-active) {
    background-color: var(--lm-primary) !important;
    border-color: var(--lm-primary) !important;
    color: #ffffff !important;
}

/* Dialog layout styling */
:global(.lm-dialog) {
    border-radius: 6px !important;
    overflow: hidden;
    box-shadow: var(--lm-shadow) !important;
    background-color: var(--lm-bg-primary) !important;
}

:global(.lm-dialog .el-dialog__header) {
    border-bottom: 1px solid var(--lm-border) !important;
    padding: 16px 20px !important;
    margin-right: 0 !important;
    background-color: var(--lm-bg-primary) !important;
}

:global(.lm-dialog .el-dialog__title) {
    font-size: 14px !important;
    font-weight: 600 !important;
    color: var(--lm-text-primary) !important;
    font-family: var(--lm-font-sans);
}

:global(.lm-dialog .el-dialog__body) {
    padding: 20px !important;
    background-color: var(--lm-bg-primary) !important;
    color: var(--lm-text-primary) !important;
}

:global(.lm-dialog .el-dialog__footer) {
    border-top: 1px solid var(--lm-border) !important;
    padding: 12px 20px !important;
    background-color: var(--lm-bg-secondary) !important;
}

:global(.lm-dialog-overlay) {
    background-color: rgba(0, 0, 0, 0.4) !important;
    backdrop-filter: blur(1px);
}

/* Form items in Dialogs */
:global(.lm-dialog .el-form-item) {
    margin-bottom: 16px !important;
}

:global(.lm-dialog .el-form-item__label) {
    color: var(--lm-text-secondary) !important;
    font-size: 13px !important;
}

/* Snapshot dialog detail contents */
.snapshot-dialog-meta {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 16px;
    padding: 14px;
    border: 1px solid var(--lm-border);
    border-radius: 4px;
    background-color: var(--lm-bg-secondary);
}

@media (max-width: 768px) {
    .snapshot-dialog-meta {
        grid-template-columns: 1fr 1fr;
    }
}

.snapshot-dialog-meta > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.snapshot-dialog-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--lm-text-tertiary) !important;
    font-family: var(--lm-font-mono);
}

.snapshot-dialog-meta span:last-child {
    font-family: var(--lm-font-mono);
    font-size: 12px;
    color: var(--lm-text-primary) !important;
}

.snapshot-dialog-query {
    grid-column: 1 / -1;
    border-top: 1px solid var(--lm-border);
    padding-top: 8px;
    margin-top: 4px;
}

.snapshot-dialog-query span:last-child {
    font-family: var(--lm-font-mono) !important;
    font-size: 12px !important;
    line-height: 1.4 !important;
}

.snapshot-memory-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.snapshot-memory-item {
    border: 1px solid var(--lm-border) !important;
    border-radius: 4px !important;
    background-color: var(--lm-bg-primary) !important;
    padding: 14px !important;
    display: flex;
    flex-direction: column;
    gap: 10px !important;
}

.snapshot-memory-header {
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px dashed var(--lm-border);
    padding-bottom: 8px;
}

.snapshot-memory-id {
    font-family: var(--lm-font-mono);
    font-weight: 600;
    color: var(--lm-text-secondary) !important;
    font-size: 12px;
}

.snapshot-memory-score {
    margin-left: auto;
    font-family: var(--lm-font-mono);
    color: var(--lm-primary) !important;
    font-size: 12px !important;
    font-weight: 600;
}

.snapshot-memory-content {
    font-size: 13px !important;
    line-height: 1.5 !important;
    color: var(--lm-text-primary) !important;
}

.snapshot-memory-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 16px !important;
    font-size: 11px !important;
    color: var(--lm-text-tertiary) !important;
    font-family: var(--lm-font-mono);
}

.snapshot-memory-summary {
    font-size: 12px !important;
    background-color: var(--lm-bg-secondary) !important;
    border-left: 2px solid var(--lm-primary);
    padding: 6px 10px !important;
    color: var(--lm-text-secondary) !important;
    border-radius: 0 4px 4px 0;
}

.snapshot-memory-keywords {
    margin-top: 2px;
}

.snapshot-memory-missing {
    color: var(--lm-danger);
    font-size: 12px;
    font-family: var(--lm-font-mono);
}
</style>
