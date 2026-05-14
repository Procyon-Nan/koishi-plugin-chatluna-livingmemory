import { send } from '@koishijs/client'
import type {
    DreamTriggerResult,
    MemoryEntryType,
    MemoryEntryStatus,
    MemoryEntryRecord,
    MemorySnapshotRecord,
    MemoryJobRecord,
    MemoryMutationInput,
    PageResult
} from './types'

export async function listPresetIds(): Promise<string[]> {
    return await send('living-memory/listPresetIds')
}

export interface MemoryListParams {
    presetId: string
    keyword?: string
    type?: MemoryEntryType
    status?: MemoryEntryStatus | 'all'
    page?: number
    pageSize?: number
}

export interface SnapshotListParams {
    presetId: string
    conversationId?: string
    page?: number
    pageSize?: number
}

export interface JobListParams {
    presetId: string
    kind?: string
    status?: string
    page?: number
    pageSize?: number
}

export async function listMemories(params: MemoryListParams): Promise<PageResult<MemoryEntryRecord>> {
    return await send('living-memory/listMemories', params)
}

export async function getMemory(memoryId: string): Promise<MemoryEntryRecord | undefined> {
    return await send('living-memory/getMemory', memoryId)
}

export async function createMemory(
    presetId: string,
    memory: MemoryMutationInput
): Promise<MemoryEntryRecord> {
    return await send('living-memory/createMemory', {
        conversationId: `webui:${presetId}`,
        presetId,
        memory
    })
}

export async function updateMemory(
    memoryId: string,
    patch: Partial<MemoryMutationInput>
): Promise<{ success: true }> {
    return await send('living-memory/updateMemory', memoryId, patch)
}

export async function deleteMemory(memoryId: string): Promise<{ success: true }> {
    return await send('living-memory/deleteMemory', memoryId)
}

export async function listSnapshots(params: SnapshotListParams): Promise<PageResult<MemorySnapshotRecord>> {
    return await send('living-memory/listSnapshots', params)
}

export async function listJobs(params: JobListParams): Promise<PageResult<MemoryJobRecord>> {
    return await send('living-memory/listJobs', params)
}

export async function runDream(presetId: string): Promise<DreamTriggerResult> {
    return await send('living-memory/runDream', presetId)
}

export async function clearPresetData(presetId: string): Promise<{ success: true }> {
    return await send('living-memory/clearPresetData', presetId)
}
