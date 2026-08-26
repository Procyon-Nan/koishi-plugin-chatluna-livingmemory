<template>
    <div class="search-test-tab">
        <div class="search-form">
            <div class="form-row">
                <div class="form-field">
                    <label class="field-label">搜索文本</label>
                    <el-input
                        v-model="searchText"
                        placeholder="输入第一人称描述语句"
                        clearable
                        @keyup.enter="doSearch"
                    />
                </div>
                <div class="form-field">
                    <label class="field-label">关键词（选填）</label>
                    <el-select
                        v-model="searchKeywords"
                        multiple
                        filterable
                        allow-create
                        default-first-option
                        :reserve-keyword="false"
                        placeholder="输入关键词后回车添加"
                        :popper-class="
                            isDark
                                ? 'lm-select-popper lm-theme-dark'
                                : 'lm-select-popper lm-theme-light'
                        "
                    />
                </div>
            </div>
            <div class="form-row form-row-bottom">
                <div class="form-field">
                    <label class="field-label">记忆类别</label>
                    <div class="type-button-group">
                        <button
                            :class="['type-btn', { active: isAllSelected }]"
                            @click="selectAll"
                        >
                            全部
                        </button>
                        <button
                            v-for="t in memoryEntryTypes"
                            :key="t"
                            :class="[
                                'type-btn',
                                {
                                    active:
                                        !isAllSelected &&
                                        selectedTypes.includes(t)
                                }
                            ]"
                            @click="toggleType(t)"
                        >
                            {{ getMemoryTypeLabel(t) }}
                        </button>
                    </div>
                </div>
                <div class="form-actions">
                    <el-button
                        :loading="searching"
                        :disabled="!presetId || disabled"
                        @click="doSearch"
                    >
                        搜索
                    </el-button>
                </div>
            </div>
        </div>

        <div v-loading="searching" class="result-panel">
            <el-empty
                v-if="hasSearched && !searching && results.length === 0"
                description="未找到匹配的记忆"
                :image-size="64"
            />

            <div v-if="results.length > 0" class="result-card-list">
                <article
                    v-for="(item, index) in results"
                    :key="item.id"
                    :class="['result-card', `result-card--${item.type}`]"
                >
                    <div class="result-card-main">
                        <div class="result-card-header">
                            <div class="result-card-kicker">
                                <span
                                    :class="[
                                        'type-text-span',
                                        getMemoryTagType(item.type)
                                    ]"
                                >
                                    {{ getMemoryTypeLabel(item.type) }}
                                </span>
                                <span class="result-rank">
                                    #{{ index + 1 }}
                                </span>
                            </div>
                            <div class="score-panel">
                                <div class="score-item">
                                    <span class="score-label">cosine</span>
                                    <span
                                        :class="[
                                            'score-value',
                                            cosineScoreClass(item.cosineScore)
                                        ]"
                                    >
                                        {{ item.cosineScore.toFixed(4) }}
                                    </span>
                                </div>
                                <div class="score-item">
                                    <span class="score-label">关键词</span>
                                    <span
                                        :class="[
                                            'score-value',
                                            item.keywordMatchCount > 0
                                                ? 'score-hit'
                                                : 'score-zero'
                                        ]"
                                    >
                                        {{ item.keywordMatchCount }}
                                    </span>
                                </div>
                                <div class="score-divider" />
                                <div class="score-item">
                                    <span class="score-label">boosted</span>
                                    <strong class="score-value score-boosted">
                                        {{ item.boostedScore.toFixed(4) }}
                                    </strong>
                                </div>
                            </div>
                        </div>

                        <p v-if="item.summary" class="result-card-summary">
                            {{ item.summary }}
                        </p>
                        <p class="result-card-content">
                            {{ item.content }}
                        </p>

                        <div
                            v-if="item.keywords.length > 0"
                            class="result-card-footer"
                        >
                            <div class="result-keywords">
                                <el-tag
                                    v-for="kw in item.keywords"
                                    :key="kw"
                                    size="small"
                                    effect="plain"
                                >
                                    {{ kw }}
                                </el-tag>
                            </div>
                        </div>
                    </div>
                </article>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useColorMode } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import * as api from '../api'
import { getMemoryTypeLabel, getMemoryTagType } from '../utils/display'
import {
    memoryEntryTypes,
    type LivingMemorySearchDetailedResult,
    type LivingMemorySearchInput,
    type MemoryEntryType
} from '../types'

const props = defineProps<{
    presetId: string
    disabled: boolean
}>()

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const searchText = ref('')
const searchKeywords = ref<string[]>([])
const selectedTypes = ref<string[]>(['all'])
const searching = ref(false)
const hasSearched = ref(false)
const results = ref<LivingMemorySearchDetailedResult[]>([])

const isAllSelected = computed(() => selectedTypes.value.includes('all'))

const selectAll = () => {
    selectedTypes.value = ['all']
}

const toggleType = (type: MemoryEntryType) => {
    const current = selectedTypes.value.filter((t) => t !== 'all')
    const idx = current.indexOf(type)
    if (idx >= 0) {
        current.splice(idx, 1)
    } else {
        current.push(type)
    }
    selectedTypes.value = current.length > 0 ? current : ['all']
}

const doSearch = async () => {
    if (props.disabled) {
        return
    }
    const text = searchText.value.trim()
    if (!text) {
        ElMessage.warning('请输入搜索内容')
        return
    }

    searching.value = true
    hasSearched.value = true
    try {
        results.value = await api.searchMemoriesDetailed(props.presetId, {
            searchTexts: [text],
            searchKeywords:
                searchKeywords.value.length > 0
                    ? searchKeywords.value
                    : undefined,
            memoryTypes:
                selectedTypes.value as LivingMemorySearchInput['memoryTypes']
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`搜索失败：${message}`)
        results.value = []
    } finally {
        searching.value = false
    }
}

const cosineScoreClass = (score: number): string => {
    if (score < 0.3) return 'score-low'
    if (score < 0.5) return 'score-mid'
    return 'score-high'
}
</script>

<style scoped src="../styles/tab-content.css"></style>
<style scoped>
.search-test-tab {
    display: flex;
    flex-direction: column;
    gap: 16px;
    flex: 1;
    min-height: 0;
}

/* ---------- Search form ---------- */

.search-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.form-row {
    display: flex;
    gap: 16px;
    align-items: flex-end;
}

.form-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
}

.field-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 16px;
    color: var(--lm-text-tertiary);
    font-family: var(--lm-font-mono);
}

.form-actions {
    flex-shrink: 0;
    padding-bottom: 2px;
}

/*
 * Force el-input wrapper to exactly 34px so it matches el-select's
 * min-height. EP's el-input inner height defaults to calc(32px - 2px)
 * = 30px; with padding 8px the wrapper would be 38px. We set both
 * --el-input-height (to shrink the inner element) and an explicit
 * height on the wrapper for a guaranteed match.
 */
.search-form :deep(.el-input__wrapper) {
    --el-input-height: 28px;
    height: 34px !important;
}

/*
 * Theme el-select internal tags — EP defaults to primary-light-9
 * background which renders as a harsh white block in dark mode.
 * Use subtle bg-secondary + border to match project's plain tag style.
 * Increase tag size and tighten wrapper gap for a denser look.
 */
.search-form :deep(.el-select__wrapper) {
    padding-top: 2px !important;
    padding-bottom: 2px !important;
}

.search-form :deep(.el-select__selection.is-near) {
    margin-left: -10px;
}

.search-form :deep(.el-select__selection .el-tag) {
    background-color: var(--lm-bg-secondary) !important;
    border-color: var(--lm-border-hover) !important;
    color: var(--lm-text-primary) !important;
    font-size: 12px !important;
    padding: 4px 10px !important;
}

.search-form :deep(.el-select__selection .el-tag__close) {
    color: var(--lm-text-tertiary) !important;
}

.search-form :deep(.el-select__selection .el-tag__close:hover) {
    background-color: var(--lm-danger) !important;
    color: #ffffff !important;
}

/* ---------- Type button group ---------- */

.type-button-group {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.type-btn {
    padding: 6px 14px;
    border-radius: 4px;
    border: 1px solid var(--lm-border);
    background-color: var(--lm-bg-secondary);
    color: var(--lm-text-secondary);
    font-size: 12px;
    font-family: var(--lm-font-sans);
    cursor: pointer;
    transition: all 120ms ease;
}

.type-btn:hover {
    background-color: var(--lm-bg-hover);
    color: var(--lm-text-primary);
    border-color: var(--lm-border-hover);
}

.type-btn.active {
    background-color: var(--lm-primary-light);
    border-color: var(--lm-primary);
    color: var(--lm-primary);
    font-weight: 600;
}

/* ---------- Result panel ---------- */

.result-panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px;
    border: 1px solid var(--lm-border);
    border-radius: 4px;
    background-color: var(--lm-bg-secondary);
}

.result-card-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

/* ---------- Result card (mirrors memory-card structure) ---------- */

.result-card {
    --memory-accent: var(--lm-primary);
    position: relative;
    padding: 16px 16px 16px 18px;
    border: 1px solid var(--lm-border);
    border-radius: 6px;
    background-color: var(--lm-bg-primary);
    box-shadow: var(--lm-shadow);
    transition: border-color 150ms ease;
}

.result-card::before {
    content: '';
    position: absolute;
    inset: 12px auto 12px 0;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background-color: var(--memory-accent);
}

.result-card:hover {
    border-color: var(--lm-border-hover);
}

.result-card--identity {
    --memory-accent: var(--lm-primary);
}

.result-card--preference {
    --memory-accent: var(--lm-success);
}

.result-card--fact {
    --memory-accent: var(--lm-text-secondary);
}

.result-card--plan {
    --memory-accent: var(--lm-warning);
}

.result-card--context {
    --memory-accent: var(--lm-danger);
}

.result-card--other {
    --memory-accent: var(--lm-text-tertiary);
}

.result-card-main {
    min-width: 0;
}

/* Header: type + rank (left), scores (right) */

.result-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
}

.result-card-kicker {
    display: flex;
    align-items: center;
    gap: 8px;
}

.result-rank {
    font-family: var(--lm-font-mono);
    font-size: 11px;
    color: var(--lm-text-tertiary);
}

/* Score panel */

.score-panel {
    display: flex;
    align-items: center;
    gap: 14px;
}

.score-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
}

.score-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--lm-text-tertiary);
    font-family: var(--lm-font-mono);
}

.score-value {
    font-family: var(--lm-font-mono);
    font-size: 13px;
}

.score-divider {
    width: 1px;
    height: 24px;
    background-color: var(--lm-border);
}

.score-low {
    color: var(--lm-danger);
    font-weight: 600;
}

.score-mid {
    color: var(--lm-warning);
    font-weight: 600;
}

.score-high {
    color: var(--lm-success);
    font-weight: 600;
}

.score-hit {
    color: var(--lm-success);
    font-weight: 600;
}

.score-zero {
    color: var(--lm-text-tertiary);
}

.score-boosted {
    font-size: 14px;
    color: var(--lm-primary);
}

/* Content */

.result-card-summary {
    margin: 0 0 4px;
    color: var(--lm-text-primary);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.result-card-content {
    margin: 8px 0 0;
    color: var(--lm-text-primary);
    font-size: 14px;
    line-height: 1.65;
    white-space: pre-wrap;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

/* Footer */

.result-card-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed var(--lm-border);
}

.result-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

/* Responsive */

@media (max-width: 768px) {
    .form-row {
        flex-direction: column;
        align-items: stretch;
    }

    .result-card-header {
        flex-direction: column;
        align-items: flex-start;
    }

    .score-panel {
        flex-wrap: wrap;
    }
}
</style>
