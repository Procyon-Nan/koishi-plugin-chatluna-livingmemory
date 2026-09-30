<template>
    <div class="tab-pane-content">
        <div class="persona-list-panel" v-loading="loading">
            <el-empty
                v-if="items.length === 0 && !loading"
                description="暂无预设人设卡片"
                :image-size="64"
            />

            <div v-else class="persona-card-list">
                <article
                    v-for="item in items"
                    :key="item.presetId"
                    :class="[
                        'persona-card',
                        item.presetId === presetId ? 'is-current' : '',
                        hasAnomaly(item) ? 'is-anomalous' : ''
                    ]"
                >
                    <div class="persona-card-header">
                        <div class="persona-card-title-block">
                            <div class="persona-card-kicker">预设人设卡片</div>
                            <h3 class="persona-card-title">
                                {{ item.presetId }}
                            </h3>
                        </div>
                        <div class="persona-card-badges">
                            <span
                                v-if="item.presetId === presetId"
                                class="persona-badge current"
                            >
                                当前预设
                            </span>
                            <span
                                class="persona-badge"
                                :class="sourceBadgeClass(item)"
                            >
                                {{ sourceBadgeLabel(item) }}
                            </span>
                            <span
                                v-if="item.usedRawFallback"
                                class="persona-badge danger"
                                :title="rawFallbackHint"
                            >
                                已回退原文
                            </span>
                            <span
                                v-if="item.stale"
                                class="persona-badge warning"
                                :title="staleHint"
                            >
                                预设已变动
                            </span>
                            <span
                                v-if="item.presetMissing"
                                class="persona-badge danger"
                                :title="missingHint"
                            >
                                预设不存在
                            </span>
                        </div>
                    </div>

                    <p class="persona-card-content">{{ item.card }}</p>

                    <div class="persona-card-footer">
                        <div class="persona-card-meta">
                            <span>保留 {{ keptLines(item) }} 行</span>
                            <span v-if="item.deletedLines > 0">
                                删减 {{ item.deletedLines }} 行
                            </span>
                            <span>更新 {{ formatTime(item.updatedAt) }}</span>
                        </div>
                        <div class="persona-card-actions">
                            <el-button
                                size="small"
                                plain
                                @click="editCard(item)"
                            >
                                编辑
                            </el-button>
                            <el-button
                                size="small"
                                type="danger"
                                plain
                                :loading="resettingPresetId === item.presetId"
                                @click="resetCard(item)"
                            >
                                重新生成
                            </el-button>
                        </div>
                    </div>
                </article>
            </div>
        </div>

        <preset-persona-editor-dialog
            v-model="dialogVisible"
            :card-info="editingCard"
            :is-dark="isDark"
            @saved="onSaved"
        />
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as api from '../api'
import { formatTime } from '../utils/display'
import type { PresetPersonaCardInfo } from '../types'
import PresetPersonaEditorDialog from './preset-persona-editor-dialog.vue'

const props = withDefaults(
    defineProps<{
        presetId?: string
        isDark: boolean
    }>(),
    { presetId: '' }
)

const emit = defineEmits<{
    'total-change': [total: number]
}>()

const rawFallbackHint =
    '删减被守卫拦下（删除比例过高或剪出结果过短），当前使用预设原文。'
const staleHint = '预设原文在上次手工编辑后已变动，卡片未随预设更新。'
const missingHint = '该预设当前已不存在，卡片是残留数据。'

const items = shallowRef<PresetPersonaCardInfo[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const editingCard = ref<PresetPersonaCardInfo | null>(null)
const resettingPresetId = ref<string | null>(null)

const hasAnomaly = (item: PresetPersonaCardInfo) =>
    item.usedRawFallback || item.stale || item.presetMissing

const sourceBadgeClass = (item: PresetPersonaCardInfo) =>
    item.source === 'manual' ? 'warning' : 'info'

const sourceBadgeLabel = (item: PresetPersonaCardInfo) =>
    item.source === 'manual' ? '手工编辑' : '自动生成'

const keptLines = (item: PresetPersonaCardInfo) =>
    Math.max(item.totalLines - item.deletedLines, 0)

const refresh = async (): Promise<boolean> => {
    loading.value = true
    try {
        items.value = await api.listPresetPersonas()
        emit('total-change', items.value.length)
        return true
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取预设人设卡片失败：${message}`)
        return false
    } finally {
        loading.value = false
    }
}

const editCard = (item: PresetPersonaCardInfo) => {
    editingCard.value = item
    dialogVisible.value = true
}

const onSaved = async () => {
    await refresh()
}

const resetCard = async (item: PresetPersonaCardInfo) => {
    try {
        await ElMessageBox.confirm(
            `重新生成将丢弃 ${item.presetId} 的当前卡片（含手工编辑内容），` +
                '并按预设原文重新生成。是否继续？',
            '重新生成卡片',
            {
                type: 'warning',
                confirmButtonText: '确认重新生成',
                cancelButtonText: '取消'
            }
        )
    } catch {
        return
    }

    resettingPresetId.value = item.presetId
    try {
        await api.resetPresetPersonaCard(item.presetId)
        ElMessage.success('卡片已重新生成')
        await refresh()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`重新生成失败：${message}`)
    } finally {
        resettingPresetId.value = null
    }
}

onMounted(() => {
    void refresh()
})

defineExpose({ refresh })
</script>

<style scoped src="../styles/preset-personas.css"></style>
<style scoped src="../styles/tab-content.css"></style>
