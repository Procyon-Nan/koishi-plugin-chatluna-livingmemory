import { send } from '@koishijs/client'
import type {
    DreamTriggerResult,
    LivingMemoryClientEvents,
    LivingMemoryPresetExport,
    LivingMemoryPresetImportResult,
    LivingMemorySearchDetailedResult,
    LivingMemorySearchInput,
    MemoryEntryRecord,
    MemoryEntryStatus,
    MemoryEntryType,
    MemoryJobRecord,
    MemoryListFilter,
    MemoryListResult,
    MemoryMutationInput,
    MemoryServiceStatus,
    MemorySnapshotRecord,
    PageResult,
    UserProfileRecord
} from './types'

const sendLivingMemory = send as unknown as <
    Name extends keyof LivingMemoryClientEvents
>(
    name: Name,
    ...args: Parameters<LivingMemoryClientEvents[Name]>
) => Promise<Awaited<ReturnType<LivingMemoryClientEvents[Name]>>>

export async function listPresetIds(): Promise<string[]> {
    return await sendLivingMemory('living-memory/listPresetIds')
}

export async function getStatus(): Promise<MemoryServiceStatus> {
    return await sendLivingMemory('living-memory/getStatus')
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

export interface UserProfileListParams {
    presetId: string
    page?: number
    pageSize?: number
}

export async function listMemories(
    params: MemoryListParams
): Promise<MemoryListResult> {
    return await sendLivingMemory('living-memory/listMemories', params)
}

export async function listMemoryIds(
    filter: MemoryListFilter
): Promise<string[]> {
    return await sendLivingMemory('living-memory/listMemoryIds', filter)
}

export async function getMemory(
    memoryId: string
): Promise<MemoryEntryRecord | undefined> {
    return await sendLivingMemory('living-memory/getMemory', memoryId)
}

export async function createMemory(
    presetId: string,
    memory: MemoryMutationInput
): Promise<MemoryEntryRecord> {
    return await sendLivingMemory('living-memory/createMemory', {
        conversationId: `webui:${presetId}`,
        presetId,
        memory
    })
}

export async function updateMemory(
    memoryId: string,
    patch: Partial<MemoryMutationInput>
): Promise<{ success: true }> {
    return await sendLivingMemory('living-memory/updateMemory', memoryId, patch)
}

export async function deleteMemory(
    memoryId: string
): Promise<{ success: true }> {
    return await sendLivingMemory('living-memory/deleteMemory', memoryId)
}

export async function deleteMemories(
    presetId: string,
    ids: string[]
): Promise<{ success: true; deleted: number }> {
    return await sendLivingMemory('living-memory/deleteMemories', presetId, ids)
}

export async function listSnapshots(
    params: SnapshotListParams
): Promise<PageResult<MemorySnapshotRecord>> {
    return await sendLivingMemory('living-memory/listSnapshots', params)
}

export async function deleteSnapshot(
    snapshotId: string
): Promise<{ success: true }> {
    return await sendLivingMemory('living-memory/deleteSnapshot', snapshotId)
}

export async function listJobs(
    params: JobListParams
): Promise<PageResult<MemoryJobRecord>> {
    return await sendLivingMemory('living-memory/listJobs', params)
}

export async function listUserProfiles(
    params: UserProfileListParams
): Promise<PageResult<UserProfileRecord>> {
    return await sendLivingMemory('living-memory/listUserProfiles', params)
}

export async function deleteUserProfile(
    profileId: string
): Promise<{ success: true }> {
    return await sendLivingMemory('living-memory/deleteUserProfile', profileId)
}

export async function updateUserProfile(
    profileId: string,
    content: string
): Promise<{ success: true }> {
    return await sendLivingMemory(
        'living-memory/updateUserProfile',
        profileId,
        content
    )
}

export async function runDream(presetId: string): Promise<DreamTriggerResult> {
    return await sendLivingMemory('living-memory/runDream', presetId)
}

export async function reconcileVectorIndex(
    presetId: string
): Promise<MemoryJobRecord> {
    return await sendLivingMemory(
        'living-memory/reconcileVectorIndex',
        presetId
    )
}

export async function rebuildVectorIndex(): Promise<{ success: true }> {
    return await sendLivingMemory('living-memory/rebuildVectorIndex')
}

export async function restartVectorIndex(): Promise<{ success: true }> {
    return await sendLivingMemory('living-memory/restartVectorIndex')
}

export async function clearPresetData(
    presetId: string
): Promise<{ success: true }> {
    return await sendLivingMemory('living-memory/clearPresetData', presetId)
}

export async function exportPreset(
    presetId: string
): Promise<LivingMemoryPresetExport> {
    return await sendLivingMemory('living-memory/exportPreset', presetId)
}

export async function importPreset(
    targetPresetId: string,
    data: LivingMemoryPresetExport
): Promise<LivingMemoryPresetImportResult> {
    return await sendLivingMemory(
        'living-memory/importPreset',
        targetPresetId,
        data
    )
}

export async function searchMemoriesDetailed(
    presetId: string,
    input: LivingMemorySearchInput
): Promise<LivingMemorySearchDetailedResult[]> {
    return await sendLivingMemory(
        'living-memory/searchMemoriesDetailed',
        presetId,
        input
    )
}
