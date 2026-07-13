<template>
    <el-dialog
        v-model="visible"
        :title="dialogTitle"
        width="720px"
        :class="['lm-dialog', isDark ? 'lm-theme-dark' : 'lm-theme-light']"
        modal-class="lm-dialog-overlay"
    >
        <el-form label-width="96px">
            <el-form-item label="类型">
                <el-select
                    v-model="form.type"
                    placeholder="请选择类型"
                    :popper-class="
                        isDark
                            ? 'lm-select-popper lm-theme-dark'
                            : 'lm-select-popper lm-theme-light'
                    "
                >
                    <el-option
                        v-for="item in memoryTypes"
                        :key="item"
                        :label="item"
                        :value="item"
                    />
                </el-select>
            </el-form-item>

            <el-form-item label="状态">
                <el-select
                    v-model="form.status"
                    placeholder="请选择状态"
                    :popper-class="
                        isDark
                            ? 'lm-select-popper lm-theme-dark'
                            : 'lm-select-popper lm-theme-light'
                    "
                >
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
                    :popper-class="
                        isDark
                            ? 'lm-select-popper lm-theme-dark'
                            : 'lm-select-popper lm-theme-light'
                    "
                />
            </el-form-item>
        </el-form>

        <template #footer>
            <el-button @click="visible = false">取消</el-button>
            <el-button :loading="submitPending" type="primary" @click="submit">
                保存
            </el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import * as api from '../api'
import {
    memoryEntryTypes,
    type MemoryEntryRecord,
    type MemoryEntryStatus,
    type MemoryEntryType,
    type MemoryMutationInput
} from '../types'

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
const form = reactive({
    type: 'fact' as MemoryEntryType,
    status: 'active' as MemoryEntryStatus,
    content: '',
    keywords: [] as string[],
    summary: '',
    sentiment: '',
    importance: null as number | null
})

const visible = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value)
})

const dialogTitle = computed(() =>
    props.memory == null ? '新建记忆' : '编辑记忆'
)

const hydrateForm = () => {
    form.type = props.memory?.type ?? 'fact'
    form.status = props.memory?.status ?? 'active'
    form.content = props.memory?.content ?? ''
    form.keywords = [...(props.memory?.keywords ?? [])]
    form.summary = props.memory?.summary ?? ''
    form.sentiment = props.memory?.sentiment ?? ''
    form.importance = props.memory?.importance ?? null
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
            await api.createMemory(presetId, mutation)
            ElMessage.success('记忆已创建')
        } else {
            await api.updateMemory(props.memory.id, mutation)
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
        }
    },
    { immediate: true }
)
</script>
