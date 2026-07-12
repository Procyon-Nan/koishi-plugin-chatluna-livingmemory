import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type {
    ExtractedMemoryItem,
    ExtractionPayload
} from '../src/contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope,
    MemorySourceMessage
} from '../src/contracts/memory'
import {
    type ExtractionWorkflowRepository,
    LivingMemoryExtractionCoordinator
} from '../src/service/workflows/extraction/coordinator'
import type { LivingMemoryExtractionTrace } from '../src/service/workflows/extraction/extractor'
import { LivingMemoryJobTracker } from '../src/service/workflows/job_tracker'
import {
    createJobStore,
    debug,
    logger,
    scope,
    waitFor
} from './workflow-test-utils'

const createExtractionMessages = (): LivingMemoryTranscriptMessage[] => [
    {
        role: 'user',
        speakerLabel: '用户',
        contentLines: ['用户消息'],
        createdAt: new Date('2026-07-01T00:00:00.000Z')
    },
    {
        role: 'assistant',
        speakerLabel: '助手',
        contentLines: ['助手消息'],
        createdAt: new Date('2026-07-01T00:01:00.000Z')
    }
]

const createExtractionTrace = (
    overrides: Partial<LivingMemoryExtractionTrace> = {}
): LivingMemoryExtractionTrace => ({
    extracted: [],
    prompt: null,
    output: null,
    skippedReason: null,
    parseError: null,
    ...overrides
})

const createExtractionCoordinator = (
    trace: LivingMemoryExtractionTrace,
    extractionInterval = 1,
    extractWithTrace: () => Promise<LivingMemoryExtractionTrace> = async () =>
        trace,
    queueAutoDream: (presetId: string) => void = () => {}
) => {
    const jobStore = createJobStore()
    const appended: {
        scope: MemoryScope
        sourceOriginMessages: MemorySourceMessage[]
        extracted: ExtractedMemoryItem[]
    }[] = []
    const formatter = {
        takeRecentRounds: (messages: LivingMemoryTranscriptMessage[]) =>
            messages,
        toExtractionPayload: (): ExtractionPayload => ({
            input: 'payload',
            sourceOriginMessages: [
                {
                    role: 'user',
                    speakerLabel: '用户',
                    content: '用户消息'
                }
            ]
        })
    }
    const extractor = { extractWithTrace }
    const repository: ExtractionWorkflowRepository = {
        createJob: jobStore.createJob,
        appendMemories: async (entryScope, sourceOriginMessages, extracted) => {
            appended.push({
                scope: entryScope,
                sourceOriginMessages,
                extracted
            })
        }
    }
    const coordinator = new LivingMemoryExtractionCoordinator(
        {} as Context,
        { extractionInterval, extractionRounds: 1 },
        repository,
        formatter,
        extractor,
        new LivingMemoryJobTracker(jobStore),
        queueAutoDream,
        logger,
        debug
    )
    return { coordinator, jobStore, appended }
}

const queueExtraction = async (
    coordinator: LivingMemoryExtractionCoordinator,
    firstChatCount = 0,
    secondChatCount = 1
) => {
    const messages = createExtractionMessages()
    await coordinator.queue(scope, firstChatCount, messages)
    await coordinator.queue(scope, secondChatCount, messages)
}

it('skips the first extraction call while initializing its baseline', async () => {
    const { coordinator, jobStore } = createExtractionCoordinator(
        createExtractionTrace()
    )

    await coordinator.queue(scope, 0, createExtractionMessages())

    assert.equal(jobStore.jobs.length, 0)
})

it('skips extraction when the configured interval is not reached', async () => {
    const { coordinator, jobStore } = createExtractionCoordinator(
        createExtractionTrace(),
        2
    )

    await queueExtraction(coordinator, 0, 1)

    assert.equal(jobStore.jobs.length, 0)
})

it('drops a same-scope extraction while the previous job is running', async () => {
    const extractionTrace = createExtractionTrace({
        extracted: [{ type: 'fact', content: 'memory' }]
    })
    let resolveTrace!: (trace: LivingMemoryExtractionTrace) => void
    let extractorCalls = 0
    const tracePromise = new Promise<LivingMemoryExtractionTrace>((resolve) => {
        resolveTrace = resolve
    })
    const { coordinator, jobStore } = createExtractionCoordinator(
        extractionTrace,
        1,
        async () => {
            extractorCalls += 1
            return await tracePromise
        }
    )

    await coordinator.queue(scope, 0, createExtractionMessages())
    await coordinator.queue(scope, 1, createExtractionMessages())
    await waitFor(() => extractorCalls === 1, 'extraction model call')
    await coordinator.queue(scope, 1, createExtractionMessages())

    assert.equal(extractorCalls, 1)
    assert.equal(jobStore.jobs.length, 1)

    resolveTrace(extractionTrace)
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'locked extraction completion'
    )
})

it('writes extracted memories and queues auto Dream after success', async () => {
    const extracted: ExtractedMemoryItem[] = [
        { type: 'fact', content: 'memory' }
    ]
    const autoDreamPresets: string[] = []
    const { coordinator, jobStore, appended } = createExtractionCoordinator(
        createExtractionTrace({ extracted }),
        1,
        async () => createExtractionTrace({ extracted }),
        (presetId) => autoDreamPresets.push(presetId)
    )

    await queueExtraction(coordinator)
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'successful extraction'
    )

    assert.equal(appended.length, 1)
    assert.deepEqual(appended[0]?.extracted, extracted)
    assert.deepEqual(autoDreamPresets, [scope.presetId])
})

it('marks extraction parse failures as failed jobs', async () => {
    const { coordinator, jobStore, appended } = createExtractionCoordinator(
        createExtractionTrace({ parseError: 'bad json' })
    )

    await queueExtraction(coordinator)
    await waitFor(
        () => jobStore.jobs[0]?.status === 'failed',
        'failed extraction'
    )

    assert.equal(appended.length, 0)
    assert.match(jobStore.jobs[0]?.error ?? '', /extraction parse failed/u)
})

it('marks valid empty extraction output as completed with zero memories', async () => {
    const { coordinator, jobStore, appended } = createExtractionCoordinator(
        createExtractionTrace({ extracted: [] })
    )

    await queueExtraction(coordinator)
    await waitFor(
        () => jobStore.jobs[0]?.status === 'completed',
        'empty extraction'
    )

    assert.equal(appended.length, 0)
    assert.equal(jobStore.jobs[0]?.detail, 'extracted 0 memories')
})
