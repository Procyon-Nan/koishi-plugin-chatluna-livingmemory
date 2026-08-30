<template>
    <el-dialog
        v-model="visible"
        title="快照详情"
        width="860px"
        :class="[
            'snapshot-dialog',
            'lm-dialog',
            isDark ? 'lm-theme-dark' : 'lm-theme-light'
        ]"
        modal-class="snapshot-dialog-overlay"
    >
        <template v-if="snapshot != null">
            <div class="snapshot-dialog-meta">
                <div>
                    <span class="snapshot-dialog-label">快照 ID</span>
                    <span>{{ snapshot.id }}</span>
                </div>
                <div>
                    <span class="snapshot-dialog-label">策略</span>
                    <span>{{ snapshot.strategy }}</span>
                </div>
                <div>
                    <span class="snapshot-dialog-label">命中</span>
                    <span>{{ snapshotHitCount(snapshot) }}</span>
                </div>
                <div>
                    <span class="snapshot-dialog-label">创建时间</span>
                    <span>{{ formatTime(snapshot.createdAt) }}</span>
                </div>
                <div class="snapshot-dialog-query">
                    <span class="snapshot-dialog-label">查询</span>
                    <span>{{ snapshot.query }}</span>
                </div>
            </div>

            <template v-if="isAgenticSnapshot(snapshot)">
                <div
                    v-for="(item, index) in snapshotAgenticItems(snapshot)"
                    :key="index"
                    class="snapshot-agentic-item"
                >
                    <div v-if="item.finalText" class="snapshot-final-text">
                        {{ item.finalText }}
                    </div>
                    <div class="snapshot-tool-summary">
                        <span>
                            查询：{{
                                formatSearchTexts(
                                    item.toolCallSummary.searchTexts
                                )
                            }}
                        </span>
                        <span>
                            上限：{{ item.toolCallSummary.maxCandidates }}
                        </span>
                    </div>
                    <el-empty
                        v-if="item.matchedMemories.length === 0"
                        description="该快照没有命中记忆"
                        :image-size="64"
                    />
                    <div v-else class="snapshot-memory-list">
                        <div
                            v-for="(
                                memory, memoryIndex
                            ) in item.matchedMemories"
                            :key="memoryIndex"
                            class="snapshot-memory-item"
                        >
                            <div class="snapshot-memory-header">
                                <el-tag
                                    :type="getMemoryTagType(memory.type)"
                                    size="small"
                                    effect="plain"
                                >
                                    {{ getMemoryTypeLabel(memory.type) }}
                                </el-tag>
                                <span class="snapshot-memory-score">
                                    重要度
                                    {{
                                        formatImportance(memory.importance) ||
                                        '-'
                                    }}
                                </span>
                            </div>
                            <div class="snapshot-memory-content">
                                {{ memory.content }}
                            </div>
                            <div class="snapshot-memory-meta">
                                <span>
                                    记录于：{{ formatTime(memory.createdAt) }}
                                </span>
                                <span>
                                    更新于：{{ formatTime(memory.updatedAt) }}
                                </span>
                            </div>
                            <div
                                v-if="memory.summary"
                                class="snapshot-memory-summary"
                            >
                                摘要：{{ memory.summary }}
                            </div>
                            <div class="snapshot-match-texts">
                                <span>
                                    命中查询：{{
                                        formatSearchTexts(
                                            memory.matchedSearchTexts
                                        )
                                    }}
                                </span>
                            </div>
                            <el-space
                                v-if="memory.keywords.length > 0"
                                wrap
                                class="snapshot-memory-keywords"
                            >
                                <el-tag
                                    v-for="keyword in memory.keywords"
                                    :key="keyword"
                                    size="small"
                                    effect="plain"
                                >
                                    {{ keyword }}
                                </el-tag>
                            </el-space>
                        </div>
                    </div>
                </div>
            </template>
            <template v-else>
                <el-empty
                    v-if="snapshot.resolvedItems.length === 0"
                    description="该快照没有命中记忆"
                    :image-size="64"
                />
                <div v-else class="snapshot-memory-list">
                    <div
                        v-for="item in snapshot.resolvedItems"
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
                            <span class="snapshot-memory-id">
                                {{ item.memoryId }}
                            </span>
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
                                <span>
                                    情绪：{{ item.memory.sentiment || '-' }}
                                </span>
                                <span>
                                    重要度：{{
                                        formatImportance(
                                            item.memory.importance
                                        ) || '-'
                                    }}
                                </span>
                                <span>
                                    记录于：{{
                                        formatTime(item.memory.createdAt)
                                    }}
                                </span>
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
                                    v-for="keyword in item.memory.keywords"
                                    :key="keyword"
                                    size="small"
                                    effect="plain"
                                >
                                    {{ keyword }}
                                </el-tag>
                            </el-space>
                        </template>
                        <div v-else class="snapshot-memory-missing">
                            记忆已删除或不可用
                        </div>
                    </div>
                </div>
            </template>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MemorySnapshotRecord } from '../types'
import {
    formatImportance,
    formatScore,
    formatSearchTexts,
    formatTime,
    getMemoryTagType,
    getMemoryTypeLabel,
    isAgenticSnapshot,
    snapshotAgenticItems,
    snapshotHitCount,
    snapshotItemStatusLabel,
    snapshotItemTagType
} from '../utils/display'

const props = defineProps<{
    modelValue: boolean
    snapshot: MemorySnapshotRecord | null
    isDark: boolean
}>()

const emit = defineEmits<{
    'update:modelValue': [value: boolean]
}>()

const visible = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value)
})
</script>

<style scoped src="../styles/snapshot-dialog.css"></style>
<style scoped src="../styles/tab-content.css"></style>
