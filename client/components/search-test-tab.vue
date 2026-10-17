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
                                <div
                                    v-if="item.rerankScore != null"
                                    class="score-item"
                                >
                                    <span class="score-label">rerank</span>
                                    <strong class="score-value score-boosted">
                                        {{ item.rerankScore.toFixed(4) }}
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
<style scoped src="../styles/search-test.css"></style>
