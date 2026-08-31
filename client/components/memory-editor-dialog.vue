<template>
    <el-dialog
        v-model="visible"
        width="680px"
        :close-on-click-modal="false"
        :class="[
            'memory-editor-dialog',
            'lm-dialog',
            isDark ? 'lm-theme-dark' : 'lm-theme-light'
        ]"
        modal-class="lm-dialog-overlay"
        @opened="focusContent"
    >
        <template #header>
            <div class="memory-editor-heading">
                <h2>{{ dialogTitle }}</h2>
                <p v-if="memory != null">
                    创建于 {{ formatTime(memory.createdAt) }}
                    <span aria-hidden="true">·</span>
                    更新于 {{ formatTime(memory.updatedAt) }}
                </p>
            </div>
        </template>

        <el-form class="memory-editor-body" label-position="top">
            <el-form-item label="摘要">
                <el-input
                    v-model="form.summary"
                    type="textarea"
                    resize="none"
                    :autosize="{ minRows: 2, maxRows: 4 }"
                    placeholder="可选，简要概括该记忆"
                />
            </el-form-item>

            <el-form-item class="memory-editor-content-field" label="记忆内容">
                <el-input
                    ref="contentInput"
                    v-model="form.content"
                    type="textarea"
                    resize="none"
                    :autosize="{ minRows: 5, maxRows: 10 }"
                    placeholder="请输入记忆内容"
                />
            </el-form-item>

            <el-form-item class="memory-editor-speakers" label="关联用户">
                <el-select
                    v-model="form.speakerKeys"
                    multiple
                    collapse-tags
                    collapse-tags-tooltip
                    :max-collapse-tags="3"
                    filterable
                    clearable
                    :loading="speakersPending"
                    placeholder="选择关联用户，可留空"
                    :popper-class="selectPopperClass"
                >
                    <el-option
                        v-for="speaker in speakers"
                        :key="speaker.speakerKey"
                        :label="speaker.speakerLabel"
                        :value="speaker.speakerKey"
                    />
                </el-select>
            </el-form-item>

            <div class="memory-editor-grid memory-editor-core-grid">
                <el-form-item label="类型">
                    <el-select
                        v-model="form.type"
                        placeholder="请选择类型"
                        :popper-class="selectPopperClass"
                    >
                        <el-option
                            v-for="item in memoryTypes"
                            :key="item"
                            :label="getMemoryTypeLabel(item)"
                            :value="item"
                        />
                    </el-select>
                </el-form-item>

                <el-form-item label="状态">
                    <el-select
                        v-model="form.status"
                        placeholder="请选择状态"
                        :popper-class="selectPopperClass"
                    >
                        <el-option label="活跃记忆" value="active" />
                        <el-option label="历史记录" value="archived" />
                    </el-select>
                </el-form-item>

                <el-form-item label="重要度">
                    <el-input-number
                        v-model="form.importance"
                        :min="0"
                        :max="1"
                        :step="0.05"
                        :precision="2"
                        controls-position="right"
                        placeholder="0 到 1"
                    />
                </el-form-item>
            </div>

            <div class="memory-editor-grid memory-editor-detail-grid">
                <el-form-item label="情绪">
                    <el-input
                        v-model="form.sentiment"
                        placeholder="例如：担心、亲近、愉快、中性"
                    />
                </el-form-item>

                <el-form-item class="memory-editor-keywords" label="关键词">
                    <el-select
                        v-model="form.keywords"
                        multiple
                        collapse-tags
                        collapse-tags-tooltip
                        :max-collapse-tags="3"
                        filterable
                        allow-create
                        default-first-option
                        placeholder="输入后按回车添加"
                        :popper-class="selectPopperClass"
                    />
                </el-form-item>
            </div>

            <div class="memory-editor-actions">
                <el-button :disabled="submitPending" @click="visible = false">
                    取消
                </el-button>
                <el-button
                    :loading="submitPending"
                    :disabled="!canSubmit"
                    @click="submit"
                >
                    {{ memory == null ? '创建记忆' : '保存更改' }}
                </el-button>
            </div>
        </el-form>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import * as api from '../api'
import {
    memoryEntryTypes,
    type MemoryEntryRecord,
    type MemoryEntryStatus,
    type MemoryEntryType,
    type MemoryMutationInput,
    type PresetSpeakerRecord
} from '../types'
import { formatTime, getMemoryTypeLabel } from '../utils/display'

const props = defineProps<{
    modelValue: boolean
    presetId: string
    memory: MemoryEntryRecord | null
    isDark: boolean
}>()

const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    saved: []
}>()

const memoryTypes = memoryEntryTypes
const submitPending = ref(false)
const speakersPending = ref(false)
const speakers = ref<PresetSpeakerRecord[]>([])
const contentInput = ref<{ focus: () => void } | null>(null)
const form = reactive({
    type: 'fact' as MemoryEntryType,
    status: 'active' as MemoryEntryStatus,
    content: '',
    keywords: [] as string[],
    summary: '',
    sentiment: '',
    importance: null as number | null,
    speakerKeys: [] as string[]
})

const visible = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value)
})

const dialogTitle = computed(() =>
    props.memory == null ? '新建记忆' : '编辑记忆'
)
const selectPopperClass = computed(() =>
    props.isDark
        ? 'lm-select-popper lm-theme-dark'
        : 'lm-select-popper lm-theme-light'
)
const canSubmit = computed(
    () =>
        props.presetId.trim().length > 0 &&
        form.content.trim().length > 0 &&
        !submitPending.value
)

const focusContent = async () => {
    await nextTick()
    contentInput.value?.focus()
}

const hydrateForm = () => {
    form.type = props.memory?.type ?? 'fact'
    form.status = props.memory?.status ?? 'active'
    form.content = props.memory?.content ?? ''
    form.keywords = [...(props.memory?.keywords ?? [])]
    form.summary = props.memory?.summary ?? ''
    form.sentiment = props.memory?.sentiment ?? ''
    form.importance = props.memory?.importance ?? null
    form.speakerKeys = [...(props.memory?.speakerKeys ?? [])]
}

const loadSpeakers = async () => {
    speakers.value = []
    speakersPending.value = true
    try {
        speakers.value = await api.listPresetSpeakers(props.presetId)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ElMessage.error(`获取关联用户失败：${message}`)
    } finally {
        speakersPending.value = false
    }
}

const normalizeImportanceInput = (value: number | null): number | null => {
    if (value == null || !Number.isFinite(value)) {
        return null
    }
    return Math.min(1, Math.max(0, value))
}

const submit = async () => {
    const presetId = props.presetId.trim()
    if (presetId.length === 0) {
        ElMessage.warning('请先输入预设 ID')
        return
    }

    const content = form.content.trim()
    if (content.length === 0) {
        ElMessage.warning('记忆内容不能为空')
        return
    }

    const mutation: MemoryMutationInput = {
        type: form.type,
        status: form.status,
        content,
        keywords: form.keywords,
        summary: form.summary.trim() || null,
        sentiment: form.sentiment.trim() || null,
        importance: normalizeImportanceInput(form.importance)
    }

    submitPending.value = true
    try {
        if (props.memory == null) {
            await api.createMemory(presetId, mutation, form.speakerKeys)
            ElMessage.success('记忆已创建')
        } else {
            await api.updateMemory(props.memory.id, {
                ...mutation,
                speakerKeys: form.speakerKeys
            })
            ElMessage.success('记忆已更新')
        }

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
    () => [props.modelValue, props.memory] as const,
    ([isVisible]) => {
        if (isVisible) {
            hydrateForm()
            void loadSpeakers()
        }
    },
    { immediate: true }
)
</script>

<style scoped src="../styles/memory-editor-dialog.css"></style>
