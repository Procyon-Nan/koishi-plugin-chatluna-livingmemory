import type { BaseMessage } from '@langchain/core/messages'
import type {
    JobListQuery,
    MemoryListQuery,
    PageResult,
    SnapshotListQuery
} from './query'
import {} from 'koishi-plugin-chatluna/services/chat'
import type { ChatLunaLivingMemoryService } from './service/memory'

export const memoryEntryTypes = [
    'identity',
    'preference',
    'fact',
    'plan',
    'context',
    'other'
] as const

export const memoryRecallStrategies = ['keyword', 'embedding-rerank'] as const

export const memoryJobKinds = ['recall', 'extract', 'dream'] as const

export const memoryJobStatuses = [
    'pending',
    'running',
    'completed',
    'failed'
] as const

export type MemoryEntryType = (typeof memoryEntryTypes)[number]
export type MemoryRecallStrategy = (typeof memoryRecallStrategies)[number]
export type MemoryJobKind = (typeof memoryJobKinds)[number]
export type MemoryJobStatus = (typeof memoryJobStatuses)[number]

export interface MemoryReference {
    memoryId: string
    score?: number | null
}

export interface MemoryScope {
    conversationId: string
    presetId: string
    userId?: string
    channelId?: string
}

export interface MemorySourceMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
}

export interface MemoryEntryRecord {
    id: string
    presetId: string
    type: MemoryEntryType
    content: string
    keywords: string[]
    summary: string | null
    sourceConversationId: string | null
    sourceMessages: MemorySourceMessage[]
    createdAt: Date
    updatedAt: Date
}

export interface MemorySnapshotRecord {
    id: string
    presetId: string
    conversationId: string
    strategy: MemoryRecallStrategy
    query: string
    items: MemoryReference[]
    createdAt: Date
}

export interface MemoryJobRecord {
    id: string
    presetId: string
    conversationId: string
    kind: MemoryJobKind
    status: MemoryJobStatus
    input: string
    detail: string | null
    error: string | null
    createdAt: Date
    startedAt: Date | null
    finishedAt: Date | null
    updatedAt: Date
}

export interface MemoryMutationInput {
    type: MemoryEntryType
    content: string
    keywords?: string[]
    summary?: string | null
}

export interface ExtractedMemoryItem {
    type: MemoryEntryType
    content: string
    keywords?: string[]
    summary?: string | null
}

export interface RetrievedMemoryItem {
    id: string
    content: string
    score: number
}

export interface ExtractionPayload {
    input: string
    sourceMessages: MemorySourceMessage[]
}

export interface LivingMemoryConfig {
    promptVariable: '{living_memory}'
    extractModel: string
    enableRecallQueryRewrite: boolean
    recallRewriteRounds: number
    recallRewriteModel: string
    embeddingModel: string
    rerankModel: string
    extractionRounds: number
    extractionInterval: number
    recallTopK: number
    maxSnapshotsPerPreset: number
    recallStrategy: MemoryRecallStrategy
    enableKeywordFallback: boolean
    debug: boolean
    extractionPrompt: string
}

export interface RecallRepository {
    listEntriesByPreset(presetId: string): Promise<MemoryEntryRecord[]>
    getEntryById(id: string): Promise<MemoryEntryRecord | undefined>
}

export interface SnapshotRepository {
    getLatestSnapshotByPreset(
        presetId: string
    ): Promise<MemorySnapshotRecord | undefined>
    listSnapshotsByPreset(presetId: string): Promise<MemorySnapshotRecord[]>
    createSnapshot(
        scope: MemoryScope,
        strategy: MemoryRecallStrategy,
        query: string,
        items: MemoryReference[]
    ): Promise<void>
}

export interface JobRepository {
    createJob(
        scope: MemoryScope,
        kind: MemoryJobKind,
        input: string
    ): Promise<MemoryJobRecord>
    updateJob(id: string, patch: Partial<MemoryJobRecord>): Promise<void>
    listJobsByPreset(presetId: string): Promise<MemoryJobRecord[]>
}

export interface ExtractionRepository {
    appendMemories(
        scope: MemoryScope,
        sourceMessages: MemorySourceMessage[],
        extracted: ExtractedMemoryItem[]
    ): Promise<void>
    createMemory(
        scope: MemoryScope,
        input: MemoryMutationInput,
        sourceMessages?: MemorySourceMessage[]
    ): Promise<MemoryEntryRecord>
    updateMemory(id: string, patch: Partial<MemoryMutationInput>): Promise<void>
    deleteMemory(id: string): Promise<void>
}

export interface MessageFormatter {
    takeRecentRounds(messages: BaseMessage[], roundCount: number): BaseMessage[]
    toExtractionPayload(
        scope: MemoryScope,
        messages: BaseMessage[]
    ): ExtractionPayload
}

declare module 'koishi' {
    interface Context {
        chatluna_living_memory: ChatLunaLivingMemoryService
    }

    interface Tables {
        living_memory_entry: MemoryEntryRecord
        living_memory_snapshot: MemorySnapshotRecord
        living_memory_job: MemoryJobRecord
    }
}

declare module '@koishijs/plugin-console' {
    interface Events {
        'living-memory/listPresetIds': () => Promise<string[]>
        'living-memory/listMemories': (
            query: MemoryListQuery
        ) => Promise<PageResult<MemoryEntryRecord>>
        'living-memory/getMemory': (
            memoryId: string
        ) => Promise<MemoryEntryRecord | undefined>
        'living-memory/createMemory': (input: {
            conversationId: string
            presetId: string
            userId?: string
            channelId?: string
            memory: MemoryMutationInput
        }) => Promise<MemoryEntryRecord>
        'living-memory/updateMemory': (
            memoryId: string,
            patch: Partial<MemoryMutationInput>
        ) => Promise<{ success: true }>
        'living-memory/deleteMemory': (
            memoryId: string
        ) => Promise<{ success: true }>
        'living-memory/listSnapshots': (
            query: SnapshotListQuery
        ) => Promise<PageResult<MemorySnapshotRecord>>
        'living-memory/listJobs': (
            query: JobListQuery
        ) => Promise<PageResult<MemoryJobRecord>>
        'living-memory/runDream': (
            presetId: string
        ) => Promise<{ success: true }>
        'living-memory/clearPresetData': (
            presetId: string
        ) => Promise<{ success: true }>
    }
}
