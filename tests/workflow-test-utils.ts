import type { JobRepository } from '../src/contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryEntryRecord,
    MemoryJobRecord,
    MemoryScope
} from '../src/contracts/memory'
import type { LivingMemoryAgenticRecallTrace } from '../src/service/workflows/recall/agentic_recall'
import type { RecallQueryResult } from '../src/service/workflows/recall/query_builder'
import type { DreamRunResult } from '../src/service/workflows/dream/types'
import { summarizeError } from '../src/service/shared/utils'
import { LivingMemoryLogger } from '../src/service/logging/logger'

export const logger = new LivingMemoryLogger(
    { info: () => {}, warn: () => {}, error: () => {} } as never,
    () => true
)
export const debug = () => {}

export const createCapturedLogger = (debugEnabled = true) => {
    const info: string[] = []
    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    return {
        logger: new LivingMemoryLogger(
            {
                info: (message: unknown) => info.push(String(message)),
                warn: (...args: unknown[]) => warnings.push(args),
                error: (...args: unknown[]) => errors.push(args)
            } as never,
            () => debugEnabled
        ),
        info,
        warnings,
        errors
    }
}

export const scope: MemoryScope = {
    conversationId: 'conversation-1',
    presetId: 'preset-1'
}

export const currentMessage: LivingMemoryTranscriptMessage = {
    role: 'user',
    speakerLabel: '用户',
    contentLines: ['记忆查询'],
    createdAt: new Date('2026-07-01T00:00:00.000Z')
}

export const createJobStore = () => {
    const jobs: MemoryJobRecord[] = []

    const createJob: JobRepository['createJob'] = async (
        jobScope,
        kind,
        input,
        recallStrategy = null
    ) => {
        const now = new Date()
        const job: MemoryJobRecord = {
            id: `job-${jobs.length + 1}`,
            presetId: jobScope.presetId,
            conversationId: jobScope.conversationId,
            kind,
            recallStrategy,
            status: 'pending',
            input,
            detail: null,
            error: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        }
        jobs.push(job)
        return job
    }

    const createFailedJob: JobRepository['createFailedJob'] = async (
        jobScope,
        kind,
        input,
        error,
        startedAt,
        recallStrategy = null
    ) => {
        const finishedAt = new Date()
        const job: MemoryJobRecord = {
            id: `job-${jobs.length + 1}`,
            presetId: jobScope.presetId,
            conversationId: jobScope.conversationId,
            kind,
            recallStrategy,
            status: 'failed',
            input,
            detail: null,
            error: summarizeError(error),
            createdAt: startedAt,
            startedAt,
            finishedAt,
            updatedAt: finishedAt
        }
        jobs.push(job)
        return job
    }

    const listJobsByPreset: JobRepository['listJobsByPreset'] = async (
        presetId
    ) => jobs.filter((job) => job.presetId === presetId)
    const updateJob: JobRepository['updateJob'] = async (id, patch) => {
        const job = jobs.find((item) => item.id === id)
        if (job == null) {
            throw new Error(`missing test job: ${id}`)
        }
        Object.assign(job, patch)
    }

    const markStaleRunningJobsAsFailed: JobRepository['markStaleRunningJobsAsFailed'] =
        async () => []

    return {
        jobs,
        createJob,
        createFailedJob,
        updateJob,
        listJobsByPreset,
        markStaleRunningJobsAsFailed
    }
}

export const createRecallQueryResult = (
    finalQuery = '记忆查询',
    overrides: Partial<RecallQueryResult> = {}
): RecallQueryResult => ({
    rawInput: finalQuery,
    rawInputLength: finalQuery.length,
    cleanedQuery: finalQuery,
    finalQuery,
    rewritePrompt: null,
    rewriteOutput: null,
    fallbackReason: 'rewrite-disabled',
    skippedReason: null,
    error: null,
    ...overrides
})

export const createMemoryEntry = (
    id: string,
    status: 'active' | 'archived' = 'active'
): MemoryEntryRecord => {
    const now = new Date('2026-07-01T00:00:00.000Z')
    return {
        id,
        presetId: scope.presetId,
        speakerKeys: [],
        type: 'fact',
        status,
        content: `content-${id}`,
        keywords: ['keyword'],
        summary: `summary-${id}`,
        sentiment: 'neutral',
        importance: 0.5,
        sourceConversationId: scope.conversationId,
        sourceOrigins: [],
        isConsolidated: false,
        createdAt: now,
        updatedAt: now
    }
}

export const createAgenticTrace = (
    finalText: string
): LivingMemoryAgenticRecallTrace => ({
    prompt: {
        systemPrompt: 'agentic system prompt',
        inputPrompt: 'agentic input prompt'
    },
    finalOutput: finalText.length > 0 ? finalText : '<NO_MEMORY>',
    item: {
        finalText,
        toolCallSummary: {
            searchTexts: ['记忆查询'],
            searchKeywords: [],
            memoryTypes: ['all'],
            maxCandidates: 3
        },
        matchedMemories:
            finalText.length > 0
                ? [
                      {
                          type: 'fact',
                          content: 'matched memory',
                          keywords: ['memory'],
                          summary: 'matched summary',
                          importance: 0.5,
                          createdAt: new Date('2026-07-01T00:00:00.000Z'),
                          updatedAt: new Date('2026-07-01T00:00:00.000Z')
                      }
                  ]
                : []
    }
})

export const waitFor = async (
    predicate: () => boolean,
    description: string,
    timeout = 1000
) => {
    const deadline = Date.now() + timeout
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${description}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

export const createDreamRunResult = (): DreamRunResult => ({
    entryCount: 0,
    clusterCount: 0,
    kept: 0,
    merged: 0,
    updated: 0,
    archived: 0,
    deleted: 0,
    skipped: 0,
    detail: 'no changes'
})
