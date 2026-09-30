<template>
    <el-dialog
        v-model="visible"
        width="720px"
        :close-on-click-modal="false"
        :class="[
            'persona-editor-dialog',
            'lm-dialog',
            isDark ? 'lm-theme-dark' : 'lm-theme-light'
        ]"
        modal-class="lm-dialog-overlay"
        @opened="focusEditor"
    >
        <template #header>
            <div class="persona-editor-heading">
                <div class="persona-editor-avatar" aria-hidden="true">
                    {{ cardInitial }}
                </div>
                <div>
                    <span class="persona-editor-kicker">编辑预设人设卡片</span>
                    <h2>{{ cardInfo?.presetId ?? '预设人设卡片' }}</h2>
                    <p v-if="cardInfo != null">
                        保留 {{ keptLines }} 行
                        <template v-if="cardInfo.deletedLines > 0">
                            <span aria-hidden="true">·</span>
                            已删减 {{ cardInfo.deletedLines }} 行
                        </template>
                        <span aria-hidden="true">·</span>
                        更新于 {{ formatTime(cardInfo.updatedAt) }}
                    </p>
                </div>
            </div>
        </template>

        <div class="persona-editor-body">
            <div class="persona-editor-field-header">
                <label for="persona-editor-card">卡片内容</label>
                <span class="persona-editor-hint">
                    保存后标记为手工编辑，预设变动时不再自动覆盖
                </span>
            </div>
            <el-input
                id="persona-editor-card"
                ref="cardInput"
                v-model="card"
                type="textarea"
                resize="none"
                :autosize="{ minRows: 14, maxRows: 22 }"
                placeholder="保留角色人格、语气、称呼与关系的部分"
                :aria-describedby="
                    validationMessage ? 'persona-editor-error' : undefined
                "
            />
            <p
                v-if="validationMessage"
                id="persona-editor-error"
                class="persona-editor-error"
            >
                {{ validationMessage }}
            </p>
            <div class="persona-editor-actions">
                <el-button :disabled="submitPending" @click="visible = false">
                    取消
                </el-button>
                <el-button
                    :loading="submitPending"
                    :disabled="!canSubmit"
                    @click="submit"
                >
                    保存更改
                </el-button>
            </div>
        </div>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import * as api from '../api'
import { formatTime } from '../utils/display'
import type { PresetPersonaCardInfo } from '../types'

const props = defineProps<{
    modelValue: boolean
    cardInfo: PresetPersonaCardInfo | null
    isDark: boolean
}>()

const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    saved: []
}>()

const card = ref('')
const submitPending = ref(false)
const cardInput = ref<{ focus: () => void } | null>(null)

const visible = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value)
})

const normalizedCard = computed(() => card.value.trim())
const originalCard = computed(() => props.cardInfo?.card.trim() ?? '')
const cardInitial = computed(
    () => Array.from(props.cardInfo?.presetId.trim() || '人')[0]
)
const keptLines = computed(() => {
    const info = props.cardInfo
    if (info == null) {
        return 0
    }
    return Math.max(info.totalLines - info.deletedLines, 0)
})
const validationMessage = computed(() => {
    if (normalizedCard.value.length === 0) {
        return '卡片内容不能为空'
    }
    return ''
})
const canSubmit = computed(
    () =>
        props.cardInfo != null &&
        validationMessage.value.length === 0 &&
        normalizedCard.value !== originalCard.value &&
        !submitPending.value
)

const focusEditor = async () => {
    await nextTick()
    cardInput.value?.focus()
}

const submit = async () => {
    const info = props.cardInfo
    if (info == null || !canSubmit.value) {
        return
    }

    submitPending.value = true
    try {
        // 落库保留原始换行，只在判空与比较时用 trim 结果
        await api.savePresetPersonaCard(info.presetId, card.value)
        ElMessage.success('预设人设卡片已保存')
        visible.value = false
        emit('saved')
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`保存失败：${message}`)
    } finally {
        submitPending.value = false
    }
}

watch(
    () => [props.modelValue, props.cardInfo] as const,
    ([isVisible]) => {
        if (isVisible) {
            card.value = props.cardInfo?.card ?? ''
        }
    },
    { immediate: true }
)
</script>

<style scoped src="../styles/preset-persona-editor-dialog.css"></style>
