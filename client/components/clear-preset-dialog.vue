<template>
    <el-dialog
        v-model="visible"
        title="清空预设数据"
        class="clear-preset-dialog"
        width="min(560px, calc(100vw - 32px))"
        :close-on-click-modal="false"
        :close-on-press-escape="!pending"
        :show-close="!pending"
        :class="['lm-dialog', isDark ? 'lm-theme-dark' : 'lm-theme-light']"
        modal-class="lm-dialog-overlay"
    >
        <div class="clear-preset-body">
            <div class="clear-warning">
                <el-icon :size="20"><warning-filled /></el-icon>
                <strong>数据清空后无法恢复</strong>
            </div>

            <section class="clear-target">
                <span class="clear-label">即将清空的预设</span>
                <strong class="clear-preset-name">{{ presetId }}</strong>
                <div class="clear-scope">
                    <span v-for="item in scopeItems" :key="item">
                        {{ item }}
                    </span>
                </div>
            </section>

            <div class="clear-confirmation">
                <label class="clear-label" for="clear-preset-confirmation">
                    输入以下语句以确认清空
                </label>
                <p id="clear-preset-phrase" class="clear-phrase">
                    {{ confirmationText }}
                </p>
                <el-input
                    id="clear-preset-confirmation"
                    v-model="confirmationInput"
                    type="textarea"
                    :rows="3"
                    resize="none"
                    :disabled="pending"
                    placeholder="在此输入上方完整语句"
                    aria-describedby="clear-preset-phrase"
                />
                <p v-if="matches" class="clear-hint" aria-live="polite">
                    确认语句已匹配，可以执行清空。
                </p>
            </div>
        </div>
        <template #footer>
            <el-button :disabled="pending" @click="visible = false">
                取消
            </el-button>
            <el-button
                type="danger"
                :disabled="!matches || pending"
                :loading="pending"
                @click="submit"
            >
                确认
            </el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { WarningFilled } from '@element-plus/icons-vue'
import * as api from '../api'
import { toErrorMessage } from '../utils/display'

const props = defineProps<{
    modelValue: boolean
    presetId: string
    isDark: boolean
}>()
const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    cleared: []
}>()

const scopeItems = ['全部记忆', '用户画像', '人设卡片', '快照', '任务记录']
const confirmationInput = ref('')
const pending = ref(false)
const visible = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value)
})
const confirmationText = computed(
    () =>
        `我确认清空预设 ${props.presetId} 的全部记忆、用户画像、人设卡片、快照和任务记录`
)
const matches = computed(
    () => confirmationInput.value === confirmationText.value
)

watch(
    () => props.modelValue,
    (isVisible) => {
        if (isVisible) confirmationInput.value = ''
    }
)

const submit = async () => {
    if (!matches.value || pending.value) return
    pending.value = true
    try {
        await api.clearPresetData(props.presetId)
        ElMessage.success('该预设的数据已清空')
        visible.value = false
        emit('cleared')
    } catch (error) {
        ElMessage.error(`清空失败：${toErrorMessage(error)}`)
    } finally {
        pending.value = false
    }
}
</script>

<style scoped src="../styles/clear-preset-dialog.css"></style>
