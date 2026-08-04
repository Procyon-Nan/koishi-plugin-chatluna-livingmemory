<template>
    <div class="search-test-tab">
        <div class="search-form">
            <div class="form-row">
                <div class="form-field">
                    <label class="field-label">searchTexts（每行一条）</label>
                    <el-input
                        v-model="searchTextsRaw"
                        type="textarea"
                        :rows="3"
                        placeholder="我今天去了图书馆&#10;我最近在准备期末考试"
                    />
                </div>
                <div class="form-field">
                    <label class="field-label">
                        searchKeywords（每行一个，选填）
                    </label>
                    <el-input
                        v-model="searchKeywordsRaw"
                        type="textarea"
                        :rows="3"
                        placeholder="考试&#10;图书馆"
                    />
                </div>
            </div>
            <div class="form-row">
                <div class="form-field">
                    <label class="field-label">memoryTypes</label>
                    <el-select
                        v-model="selectedTypes"
                        multiple
                        placeholder="选择记忆类别"
                        class="type-select"
                    >
                        <el-option label="全部" value="all" />
                        <el-option
                            v-for="t in memoryEntryTypes"
                            :key="t"
                            :label="getMemoryTypeLabel(t)"
                            :value="t"
                        />
                    </el-select>
                </div>
                <div class="form-actions">
                    <el-button
                        type="primary"
                        :loading="searching"
                        :disabled="!presetId"
                        @click="doSearch"
                    >
                        搜索
                    </el-button>
                </div>
            </div>
        </div>

        <div v-if="hasSearched && results.length === 0" class="empty-hint">
            未找到匹配的记忆。
        </div>

        <el-table
            v-if="results.length > 0"
            :data="results"
            stripe
            class="result-table"
        >
            <el-table-column type="index" label="#" width="48" />
            <el-table-column label="内容" min-width="280">
                <template #default="{ row }">
                    <div class="result-content">{{ row.content }}</div>
                    <div v-if="row.summary" class="result-summary">
                        {{ row.summary }}
                    </div>
                </template>
            </el-table-column>
            <el-table-column label="类型" width="90">
                <template #default="{ row }">
                    {{ getMemoryTypeLabel(row.type) }}
                </template>
            </el-table-column>
            <el-table-column label="关键词" min-width="140">
                <template #default="{ row }">
                    <el-tag
                        v-for="kw in row.keywords"
                        :key="kw"
                        size="small"
                        class="result-keyword-tag"
                    >
                        {{ kw }}
                    </el-tag>
                </template>
            </el-table-column>
            <el-table-column label="cosine" width="100" align="center">
                <template #default="{ row }">
                    <span :class="cosineScoreClass(row.cosineScore)">
                        {{ row.cosineScore.toFixed(4) }}
                    </span>
                </template>
            </el-table-column>
            <el-table-column label="关键词命中" width="90" align="center">
                <template #default="{ row }">
                    <span
                        :class="
                            row.keywordMatchCount > 0
                                ? 'keyword-hit'
                                : 'keyword-miss'
                        "
                    >
                        {{ row.keywordMatchCount }}
                    </span>
                </template>
            </el-table-column>
            <el-table-column label="boosted" width="100" align="center">
                <template #default="{ row }">
                    <strong>{{ row.boostedScore.toFixed(4) }}</strong>
                </template>
            </el-table-column>
        </el-table>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import * as api from '../api'
import { getMemoryTypeLabel } from '../utils/display'
import { memoryEntryTypes } from '../types'
import type {
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput
} from '../types'

const props = defineProps<{
    presetId: string
}>()

const searchTextsRaw = ref('')
const searchKeywordsRaw = ref('')
const selectedTypes = ref<string[]>(['all'])
const searching = ref(false)
const hasSearched = ref(false)
const results = ref<LivingMemorySearchDetailedResult[]>([])

const parseLines = (raw: string): string[] =>
    raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

const doSearch = async () => {
    const searchTexts = parseLines(searchTextsRaw.value)
    if (searchTexts.length === 0) {
        ElMessage.warning('请至少输入一条 searchTexts')
        return
    }

    const searchKeywords = parseLines(searchKeywordsRaw.value)
    const memoryTypes = selectedTypes.value.length > 0
        ? selectedTypes.value
        : ['all']

    searching.value = true
    hasSearched.value = true
    try {
        results.value = await api.searchMemoriesDetailed(props.presetId, {
            searchTexts,
            searchKeywords: searchKeywords.length > 0 ? searchKeywords : undefined,
            memoryTypes: memoryTypes as LivingMemorySearchInput['memoryTypes']
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
    if (score < 0.3) return 'cosine-low'
    if (score < 0.5) return 'cosine-mid'
    return 'cosine-high'
}
</script>

<style scoped>
.search-test-tab {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 4px 0;
}

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
    font-size: 13px;
    color: var(--el-text-color-secondary);
}

.form-actions {
    flex-shrink: 0;
}

.type-select {
    width: 100%;
}

.empty-hint {
    color: var(--el-text-color-secondary);
    text-align: center;
    padding: 24px 0;
}

.result-table {
    width: 100%;
}

.result-content {
    font-size: 14px;
    line-height: 1.5;
    word-break: break-word;
}

.result-summary {
    font-size: 12px;
    color: var(--el-text-color-secondary);
    margin-top: 4px;
}

.result-keyword-tag {
    margin: 2px 4px 2px 0;
}

.cosine-low {
    color: var(--el-color-danger);
    font-weight: 600;
}

.cosine-mid {
    color: var(--el-color-warning);
    font-weight: 600;
}

.cosine-high {
    color: var(--el-color-success);
    font-weight: 600;
}

.keyword-hit {
    color: var(--el-color-success);
    font-weight: 600;
}

.keyword-miss {
    color: var(--el-text-color-placeholder);
}
</style>
