<template>
    <k-layout class="living-memory-dashboard">
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
                        <strong>{{ warning.field }}</strong>：{{ warning.message }}
                    </li>
                </ul>
            </el-alert>
            <el-card shadow="never" class="toolbar-card">
                <template #header>
                    <div class="toolbar-header">
                        <span>Living Memory</span>
                    </div>
                </template>

                <div class="toolbar-grid">
                    <div class="toolbar-filters">
                        <el-select
                            v-model="presetId"
                            filterable
                            allow-create
                            default-first-option
                            clearable
                            placeholder="选择或输入预设 ID"
                            class="preset-select"
                            @change="onPresetChange"
                        >
                            <el-option
                                v-for="id in presetIds"
                                :key="id"
                                :label="id"
                                :value="id"
                            />
                        </el-select>

                        <el-input
                            v-model="memoryKeyword"
                            placeholder="按关键词过滤记忆"
                            clearable
                            class="keyword-input"
                            @keyup.enter="onMemoryFilterChange"
                            @clear="onMemoryFilterChange"
                        >
                            <template #prepend>搜索</template>
                        </el-input>

                        <el-select
                            v-model="memoryType"
                            clearable
                            placeholder="全部类型"
                            class="type-select"
                            @change="onMemoryFilterChange"
                        >
                            <el-option
                                v-for="item in memoryTypes"
                                :key="item"
                                :label="getMemoryTypeLabel(item)"
                                :value="item"
                            />
                        </el-select>

                        <el-select
                            v-model="memoryStatus"
                            placeholder="记忆状态"
                            class="status-select"
                            @change="onMemoryFilterChange"
                        >
                            <el-option label="活跃记忆" value="active" />
                            <el-option label="历史记录" value="archived" />
                            <el-option label="全部状态" value="all" />
                        </el-select>
                    </div>

                    <div class="toolbar-actions">
                        <el-button :loading="loading" type="primary" @click="refreshAll">
                            刷新
                        </el-button>
                        <el-button :disabled="!presetId" @click="openCreateDialog">
                            新建记忆
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

            <el-row :gutter="16" class="summary-row">
                <el-col :span="8">
                    <el-card shadow="never">
                        <div class="summary-item">
                            <div class="summary-label">记忆数量</div>
                            <div class="summary-value">{{ memoryTotal }}</div>
                        </div>
                    </el-card>
                </el-col>
                <el-col :span="8">
                    <el-card shadow="never">
                        <div class="summary-item">
                            <div class="summary-label">快照数量</div>
                            <div class="summary-value">{{ snapshotTotal }}</div>
                        </div>
                    </el-card>
                </el-col>
                <el-col :span="8">
                    <el-card shadow="never">
                        <div class="summary-item">
                            <div class="summary-label">任务数量</div>
                            <div class="summary-value">{{ jobTotal }}</div>
                        </div>
                    </el-card>
                </el-col>
            </el-row>

            <el-card shadow="never" class="table-card">
                <template #header>
                    <div class="card-header">
                        <span>记忆列表</span>
                        <span class="card-tip">支持按关键词和类型过滤</span>
                    </div>
                </template>

                <el-table :data="memories" border v-loading="loading" max-height="450">
                    <el-table-column prop="id" label="ID" min-width="180" />
                    <el-table-column label="类型" width="140">
                        <template #default="scope">
                            <el-tag
                                :type="getMemoryTagType(scope.row.type)"
                                size="small"
                                effect="plain"
                            >
                                {{ getMemoryTypeLabel(scope.row.type) }}
                            </el-tag>
                        </template>
                    </el-table-column>
                    <el-table-column label="状态" width="100">
                        <template #default="scope">
                            <el-tag
                                :type="scope.row.status === 'archived' ? 'info' : 'success'"
                                size="small"
                                effect="plain"
                            >
                                {{ scope.row.status === 'archived' ? '历史' : '活跃' }}
                            </el-tag>
                        </template>
                    </el-table-column>
                    <el-table-column prop="content" label="内容" min-width="260" show-overflow-tooltip />
                    <el-table-column prop="summary" label="摘要" min-width="200" show-overflow-tooltip />
                    <el-table-column prop="sentiment" label="情绪" width="120" show-overflow-tooltip />
                    <el-table-column label="重要度" width="100">
                        <template #default="scope">
                            <span :style="getImportanceStyle(scope.row.importance)">
                                {{ formatImportance(scope.row.importance) }}
                            </span>
                        </template>
                    </el-table-column>
                    <el-table-column label="关键词" min-width="200">
                        <template #default="scope">
                            <el-space wrap>
                                <el-tag
                                    v-for="kw in scope.row.keywords"
                                    :key="kw"
                                    size="small"
                                    effect="plain"
                                >
                                    {{ kw }}
                                </el-tag>
                            </el-space>
                        </template>
                    </el-table-column>
                    <el-table-column label="创建时间" min-width="160">
                        <template #default="scope">{{ formatTime(scope.row.createdAt) }}</template>
                    </el-table-column>
                    <el-table-column label="更新时间" min-width="160">
                        <template #default="scope">{{ formatTime(scope.row.updatedAt) }}</template>
                    </el-table-column>
                    <el-table-column label="操作" width="180" fixed="right">
                        <template #default="scope">
                            <el-space>
                                <el-button size="small" @click="openEditDialog(scope.row)">
                                    编辑
                                </el-button>
                                <el-button
                                    size="small"
                                    type="danger"
                                    plain
                                    @click="removeMemory(scope.row.id)"
                                >
                                    删除
                                </el-button>
                            </el-space>
                        </template>
                    </el-table-column>
                </el-table>

                <div class="pagination-container">
                    <el-pagination
                        v-model:current-page="memoryPage"
                        v-model:page-size="memoryPageSize"
                        :total="memoryTotal"
                        :page-sizes="[10, 20, 50, 100]"
                        layout="total, sizes, prev, pager, next, jumper"
                        @current-change="onMemoryPageChange"
                        @size-change="onMemorySizeChange"
                    />
                </div>
            </el-card>

            <el-row :gutter="16" class="table-row">
                <el-col :span="12">
                    <el-card shadow="never" class="table-card">
                        <template #header>
                            <div class="card-header">
                                <span>快照列表</span>
                                <span class="card-tip">展示当前预设最近保留的 living_memory</span>
                            </div>
                        </template>

                        <el-table :data="snapshots" border v-loading="loading" max-height="300">
                            <el-table-column prop="id" label="ID" min-width="160" />
                            <el-table-column prop="strategy" label="策略" width="140" />
                            <el-table-column prop="query" label="查询" min-width="180" show-overflow-tooltip />
                            <el-table-column label="命中" width="80">
                                <template #default="scope">{{ scope.row.resolvedItems.length }}</template>
                            </el-table-column>
                            <el-table-column label="创建时间" min-width="160">
                                <template #default="scope">{{ formatTime(scope.row.createdAt) }}</template>
                            </el-table-column>
                            <el-table-column label="操作" width="140" fixed="right">
                                <template #default="scope">
                                    <el-space>
                                        <el-button
                                            size="small"
                                            type="primary"
                                            link
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

                        <div class="pagination-container pagination-compact">
                            <el-pagination
                                v-model:current-page="snapshotPage"
                                v-model:page-size="snapshotPageSize"
                                :total="snapshotTotal"
                                size="small"
                                layout="total, prev, pager, next"
                                @current-change="onSnapshotPageChange"
                            />
                        </div>
                    </el-card>
                </el-col>

                <el-col :span="12">
                    <el-card shadow="never" class="table-card">
                        <template #header>
                            <div class="card-header">
                                <span>任务列表</span>
                                <span class="card-tip">异步召回、提取与 Dream 状态</span>
                            </div>
                        </template>

                        <el-table :data="jobs" border v-loading="loading" max-height="300">
                            <el-table-column prop="id" label="ID" min-width="160" />
                            <el-table-column label="类型" width="120">
                                <template #default="scope">
                                    {{ getJobKindLabel(scope.row.kind) }}
                                </template>
                            </el-table-column>
                            <el-table-column label="状态" width="120">
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
                            <el-table-column label="创建时间" min-width="160">
                                <template #default="scope">{{ formatTime(scope.row.createdAt) }}</template>
                            </el-table-column>
                            <el-table-column label="更新时间" min-width="160">
                                <template #default="scope">{{ formatTime(scope.row.updatedAt) }}</template>
                            </el-table-column>
                        </el-table>

                        <div class="pagination-container pagination-compact">
                            <el-pagination
                                v-model:current-page="jobPage"
                                v-model:page-size="jobPageSize"
                                :total="jobTotal"
                                size="small"
                                layout="total, prev, pager, next"
                                @current-change="onJobPageChange"
                            />
                        </div>
                    </el-card>
                </el-col>
            </el-row>
        </div>
    </k-layout>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="720px">
        <el-form label-width="96px">
            <el-form-item label="类型">
                <el-select v-model="form.type" placeholder="请选择类型">
                    <el-option
                        v-for="item in memoryTypes"
                        :key="item"
                        :label="item"
                        :value="item"
                    />
                </el-select>
            </el-form-item>

            <el-form-item label="状态">
                <el-select v-model="form.status" placeholder="请选择状态">
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
        class="snapshot-dialog"
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
const snapshotPageSize = ref(10)
const snapshotTotal = ref(0)

const jobPage = ref(1)
const jobPageSize = ref(10)
const jobTotal = ref(0)

const memories = ref<MemoryEntryRecord[]>([])
const snapshots = ref<MemorySnapshotRecord[]>([])
const jobs = ref<MemoryJobRecord[]>([])
const configWarnings = ref<MemoryConfigWarning[]>([])

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
        identity: '身份 (identity)',
        preference: '偏好 (preference)',
        fact: '事实 (fact)',
        plan: '计划 (plan)',
        context: '上下文 (context)',
        other: '其它 (other)'
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

const getImportanceStyle = (
    value: number | null | undefined
): Record<string, string> => {
    if (value == null) return {}
    if (value >= 0.7) {
        return { color: 'var(--el-color-danger)', fontWeight: 'bold' }
    } else if (value >= 0.4) {
        return { color: 'var(--el-color-primary)', fontWeight: 'bold' }
    }
    return { color: 'var(--el-text-color-secondary)' }
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

const onJobPageChange = (page: number) => {
    jobPage.value = page
    fetchJobs()
}

const fetchMemories = async (skipLoading = false) => {
    if (!ensurePreset()) return
    if (!skipLoading) loading.value = true
    try {
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
.living-memory-dashboard {
    height: 100%;
}

.living-memory-dashboard :deep(.layout-main) {
    overflow-y: auto;
    background-color: transparent !important;
}

.living-memory-dashboard :deep(.layout-content) {
    overflow-y: auto;
}

.dashboard-shell {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
    overflow-y: auto;
}

.config-warning-banner {
    border-radius: 12px;
}

.config-warning-list {
    margin: 4px 0 0;
    padding-left: 20px;
}

.config-warning-list li + li {
    margin-top: 4px;
}

.toolbar-card,
.table-card {
    border-radius: 12px;
}

.toolbar-header,
.card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.card-tip {
    color: var(--el-text-color-secondary);
    font-size: 13px;
}

.toolbar-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}

.toolbar-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
}

.toolbar-filters .el-select,
.toolbar-filters .el-input {
    width: 180px;
}

.toolbar-filters .preset-select {
    width: 200px;
}

.toolbar-filters .keyword-input {
    width: 240px;
}

.toolbar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
}

.pagination-container {
    display: flex;
    justify-content: flex-end;
    padding: 12px 0 0;
}

.pagination-compact {
    padding: 8px 0 0;
}

.summary-row,
.table-row {
    margin: 0;
}

.summary-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.summary-label {
    color: var(--el-text-color-secondary);
    font-size: 13px;
}

.summary-value {
    font-size: 28px;
    font-weight: 600;
}

:deep(.snapshot-detail-cell .cell) {
    padding: 0;
    overflow: visible;
    text-overflow: clip;
}

.snapshot-detail-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--el-text-color-secondary);
    cursor: pointer;
    font-size: 0;
    line-height: 1;
    overflow: hidden;
}

.snapshot-detail-button:hover,
.snapshot-detail-button:focus {
    color: var(--el-color-primary);
    background: var(--el-fill-color);
}

.snapshot-detail-icon {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-top: 1.5px solid currentColor;
    border-right: 1.5px solid currentColor;
    transform: rotate(45deg);
}

:global(.snapshot-dialog.el-dialog),
:global(.snapshot-dialog .el-dialog),
:global(.snapshot-dialog-overlay .el-dialog) {
    border: 1px solid var(--el-border-color-lighter);
    background: var(--el-card-bg-color, var(--el-bg-color));
    color: var(--el-text-color-primary);
    box-shadow: var(--el-box-shadow-dark);
}

:global(.snapshot-dialog.el-dialog .el-dialog__header),
:global(.snapshot-dialog .el-dialog__header),
:global(.snapshot-dialog-overlay .el-dialog__header) {
    border-bottom: 1px solid var(--el-border-color-lighter);
    background: var(--el-card-bg-color, var(--el-bg-color));
    margin-right: 0;
}

:global(.snapshot-dialog.el-dialog .el-dialog__title),
:global(.snapshot-dialog .el-dialog__title),
:global(.snapshot-dialog-overlay .el-dialog__title) {
    color: var(--el-text-color-primary);
}

:global(.snapshot-dialog.el-dialog .el-dialog__body),
:global(.snapshot-dialog .el-dialog__body),
:global(.snapshot-dialog-overlay .el-dialog__body) {
    max-height: 70vh;
    overflow-y: auto;
    background: var(--el-card-bg-color, var(--el-bg-color));
    color: var(--el-text-color-primary);
}

.snapshot-dialog-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 16px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 8px;
    background: var(--el-bg-color);
    color: var(--el-text-color-regular);
    font-size: 13px;
}

.snapshot-dialog-meta > div {
    display: flex;
    gap: 8px;
    min-width: 0;
}

.snapshot-dialog-label {
    flex: 0 0 auto;
    color: var(--el-text-color-secondary);
}

.snapshot-dialog-meta span:last-child {
    color: var(--el-text-color-primary);
}

.snapshot-dialog-query {
    grid-column: 1 / -1;
}

.snapshot-dialog-query span:last-child {
    white-space: pre-wrap;
    word-break: break-word;
}

.snapshot-memory-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.snapshot-memory-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 8px;
    background: var(--el-bg-color);
    color: var(--el-text-color-primary);
}

.snapshot-memory-header,
.snapshot-memory-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
}

.snapshot-memory-id,
.snapshot-memory-score,
.snapshot-memory-meta,
.snapshot-memory-summary,
.snapshot-memory-missing {
    color: var(--el-text-color-regular);
    font-size: 13px;
}

.snapshot-memory-content {
    white-space: pre-wrap;
    color: var(--el-text-color-primary);
    line-height: 1.6;
}

.snapshot-memory-summary {
    line-height: 1.5;
}

.snapshot-memory-keywords {
    margin-top: 2px;
}

@media (max-width: 1200px) {
    .toolbar-grid {
        grid-template-columns: 1fr;
    }
}
</style>
