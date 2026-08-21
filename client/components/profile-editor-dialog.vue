<template>
    <el-dialog
        v-model="visible"
        width="640px"
        :close-on-click-modal="false"
        :class="[
            'profile-editor-dialog',
            'lm-dialog',
            isDark ? 'lm-theme-dark' : 'lm-theme-light'
        ]"
        modal-class="lm-dialog-overlay"
        @opened="focusEditor"
    >
        <template #header>
            <div class="profile-editor-heading">
                <div class="profile-editor-avatar" aria-hidden="true">
                    {{ profileInitial }}
                </div>
                <div>
                    <span class="profile-editor-kicker">编辑用户画像</span>
                    <h2>{{ profile?.speakerLabel ?? '用户画像' }}</h2>
                    <p v-if="profile != null">
                        基于 {{ profile.sourceMemoryIds?.length ?? 0 }} 条记忆生成
                        <span aria-hidden="true">·</span>
                        更新于 {{ formatTime(profile.updatedAt) }}
                    </p>
                </div>
            </div>
        </template>

        <div class="profile-editor-body">
            <div class="profile-editor-field-header">
                <label for="profile-editor-content">画像内容</label>
                <span
                    class="profile-editor-count"
                    :class="{ 'is-invalid': contentLength > maxContentLength }"
                >
                    {{ contentLength }} / {{ maxContentLength }}
                </span>
            </div>
            <el-input
                id="profile-editor-content"
                ref="contentInput"
                v-model="content"
                type="textarea"
                resize="none"
                :autosize="{ minRows: 8, maxRows: 14 }"
                placeholder="描述用户的性格、偏好、习惯与重要经历"
                :aria-describedby="
                    validationMessage
                        ? 'profile-editor-error'
                        : undefined
                "
            />
            <p
                v-if="validationMessage"
                id="profile-editor-error"
                class="profile-editor-error"
            >
                {{ validationMessage }}
            </p>
            <div class="profile-editor-actions">
                <el-button :disabled="submitPending" @click="visible = false">
                    取消
                </el-button>
                <el-button
                    type="primary"
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
import type { UserProfileRecord } from '../types'
import { formatTime } from '../utils/display'

const maxContentLength = 220

const props = defineProps<{
    modelValue: boolean
    profile: UserProfileRecord | null
    isDark: boolean
}>()

const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    saved: []
}>()

const content = ref('')
const submitPending = ref(false)
const contentInput = ref<{ focus: () => void } | null>(null)

const visible = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value)
})

const normalizedContent = computed(() => content.value.trim())
const contentLength = computed(() => Array.from(normalizedContent.value).length)
const originalContent = computed(() => props.profile?.content.trim() ?? '')
const profileInitial = computed(
    () => Array.from(props.profile?.speakerLabel.trim() || '用')[0]
)
const validationMessage = computed(() => {
    if (contentLength.value === 0) {
        return '画像内容不能为空'
    }
    if (contentLength.value > maxContentLength) {
        return `画像内容不能超过 ${maxContentLength} 个字符`
    }
    return ''
})
const canSubmit = computed(
    () =>
        props.profile != null &&
        validationMessage.value.length === 0 &&
        normalizedContent.value !== originalContent.value &&
        !submitPending.value
)

const focusEditor = async () => {
    await nextTick()
    contentInput.value?.focus()
}

const submit = async () => {
    const profile = props.profile
    if (profile == null || !canSubmit.value) {
        return
    }

    submitPending.value = true
    try {
        await api.updateUserProfile(profile.id, normalizedContent.value)
        ElMessage.success('用户画像已更新')
        visible.value = false
        emit('saved')
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`更新失败：${message}`)
    } finally {
        submitPending.value = false
    }
}

watch(
    () => [props.modelValue, props.profile] as const,
    ([isVisible]) => {
        if (isVisible) {
            content.value = props.profile?.content ?? ''
        }
    },
    { immediate: true }
)
</script>

<style scoped src="../styles/profile-editor-dialog.css"></style>
